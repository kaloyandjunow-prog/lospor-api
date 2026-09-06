import { NextRequest, NextResponse, after } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { mapPreop, mapPreopUpdate, mapIntraop, mapIntraopUpdate, mapPostop, mapPostopUpdate } from "../_mappers"
import { z } from "zod"
import { logAudit, logAuditInTransaction } from "@/lib/audit"
import { preopSchema, intraopSchema, postopSchema } from "@/lib/schemas/case"
import { parseLenient } from "@/lib/lenient-parse"
import { checkClinicalPayloadPII, piiErrorBody } from "@/lib/clinical-pii"
import { resolveDrugExposureConcepts, syncCaseRelationalLockedSafe } from "@/lib/relational-sync"
import { writeFieldDiffsSafe } from "@/lib/case-audit"
import { rebuildProjection, reconcileFullLog, snapshotLogForReconcile } from "@/lib/case-events"
import {
  canWriteCaseWithOwnerFallback,
  caseCapabilitiesForUser,
  caseReadWhereForUser,
} from "@/lib/access-control"
import { corsHeaders } from "@/lib/cors"
import type { CaseDetail, Serialized } from "@/types/case-detail"
import type { LegacyKeyEvents, LogEvent, ClinicalEvent } from "@/types/timetable"
import type { CaseStatus } from "@/generated/prisma/enums"
import {
  INTRAOP_COLUMN_MS,
  intraopInstantForColumn,
} from "@lospor/core/intraop-engine"
import { SECTION_REVISION_HEADER } from "@lospor/core/sync"
import { normalizeOptionCodes } from "@lospor/core/option-aliases"
import {
  CaseWriteError,
  isCaseFinalizedDatabaseError,
  withLockedCaseTransaction,
} from "@/lib/clinical-transaction"
import { pediatricMutationResponse } from "@/lib/pediatric-http"
import { decidePediatricWrite } from "@/lib/pediatric-mode"
import { requiresPediatricModeDecision } from "@lospor/core/pediatric"

const CORS = (req: NextRequest) => corsHeaders(req)
const REVISION_HEADER = SECTION_REVISION_HEADER

function readRevision(req: NextRequest, section: keyof typeof REVISION_HEADER): number | null | "invalid" {
  const raw = req.headers.get(REVISION_HEADER[section])
  if (raw == null) return null
  if (!/^\d+$/.test(raw)) return "invalid"
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : "invalid"
}

class CaseRouteResponse extends Error {
  constructor(readonly response: NextResponse) {
    super("CASE_ROUTE_RESPONSE")
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

const patchBodySchema = z.object({
  // "COMPLETE" is intentionally excluded — use POST /api/cases/:id/finalize instead.
  status:      z.enum(["DRAFT", "IN_PROGRESS", "AWAITING_REVIEW"]).optional(),
  notes:       z.string().max(1000).nullable().optional(),
  preop:       preopSchema.optional(),
  intraop:     intraopSchema.optional(),
  clinicalMode: z.enum(["ADULT", "PEDIATRIC"]).optional(),
  postop:      postopSchema.optional(),
  // Acknowledges that this save will overwrite a newer version, and asks
  // for it anyway. Formerly `forceUpdate`, which read like a retry hint and
  // silently discarded a colleague's edits. Renamed so a client cannot send
  // it without meaning it, and always recorded when it takes effect.
  overrideConflict: z.boolean().optional(),
})

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const where = caseReadWhereForUser(user, id)

  const record = await prisma.case.findFirst({
    where,
    include: {
      preop: true,
      intraop: true,
      postop: true,
      clinicalCalculations: true,
      institution: { select: { name: true, city: true } },
      user: {
        select: {
          name: true,
          institution: { select: { name: true } },
        },
      },
    },
  })
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const pediatricModeDecisionRequired = requiresPediatricModeDecision({
    clinicalMode: record.clinicalMode,
    ageValue: record.preop?.ageValue,
    ageUnit: record.preop?.ageUnit,
    ageYears: record.preop?.ageYears,
  })
  const normalizedRecord = record.intraop && Array.isArray(record.intraop.techniques)
    ? {
        ...record,
        pediatricModeDecisionRequired,
        intraop: {
          ...record.intraop,
          techniques: normalizeOptionCodes(
            "TECHNIQUE",
            record.intraop.techniques.filter(
              (value): value is string => typeof value === "string",
            ),
          ),
        },
      }
    : { ...record, pediatricModeDecisionRequired }
  // Prisma JSON columns are intentionally broad at the persistence boundary.
  // The response contract is the shared serialised CaseDetail shape.
  const responseRecord = {
    ...normalizedRecord,
    capabilities: caseCapabilitiesForUser(user, record),
  } as unknown as Serialized<CaseDetail>

  // Extending open infusion/fluid/agent bars to "now" on read used to happen here,
  // server-side. It was removed: the server has no way to know the client's local
  // timezone, while startTime/endTime are stored as literal HH:MM digits with no
  // real timezone attached (intentional - these are wall-clock times, not instants).
  // Comparing the server's own UTC clock against that gave wrong results for any
  // user not in UTC (e.g. a 01:20 local start showing as if it started ~23:20 the
  // day before once the page reopened). The client-side live clock in
  // IntraopTimetable.tsx already extends these bars correctly on mount, using the
  // browser's own local clock against the same literal HH:MM digits - both sides
  // of that comparison are in the same wall-clock frame, so it round-trips correctly
  // regardless of actual UTC offset.

  return NextResponse.json(responseRecord)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = user.id

  const { id } = await params

  try {
    // Autosave posts whole sections repeatedly, so a single out-of-range value
    // must not discard the rest of the save. Invalid fields are dropped and
    // reported back as `rejectedFields` for the client to surface.
    const { value: body, rejected: rejectedFields } = parseLenient(patchBodySchema, await req.json())
    // Keep the signal that used to arrive as a ZodError before this route
    // started tolerating bad fields — a client sending consistently invalid
    // values would otherwise be invisible. Paths only: the values themselves
    // are clinical data and must not reach the logs.
    if (rejectedFields.length) {
      console.warn(`[PATCH /api/cases/:id] rejected fields on ${id}:`, rejectedFields.map(f => f.path).join(", "))
    }
    const { preop, intraop, postop, status, clinicalMode, notes, overrideConflict: overrideField } = body
    const preopBase = req.headers.get("x-lospor-preop-updated-at")
    const postopBase = req.headers.get("x-lospor-postop-updated-at")
    const intraopBase = req.headers.get("x-lospor-intraop-updated-at")
    const preopRevision = readRevision(req, "preop")
    const postopRevision = readRevision(req, "postop")
    const intraopRevision = readRevision(req, "intraop")
    const overrideConflict = req.headers.get("x-lospor-override-conflict") === "true" ||
      overrideField === true

    const clientVersion = req.headers.get("x-lospor-client-version")
    for (const [name, revision] of [["preop", preopRevision], ["postop", postopRevision], ["intraop", intraopRevision]] as const) {
      if (revision === "invalid") {
        return NextResponse.json({ error: `Invalid ${name} revision` }, { status: 400 })
      }
    }

    // Reject an unparseable conflict header instead of silently skipping the
    // guard (NaN comparisons are always false -> a stale write would slip through).
    for (const [name, h] of [["preop", preopBase], ["postop", postopBase], ["intraop", intraopBase]] as const) {
      if (h && Number.isNaN(new Date(h).getTime())) {
        return NextResponse.json({ error: `Invalid ${name} conflict timestamp` }, { status: 400 })
      }
    }

    const piiError = checkClinicalPayloadPII({ preop, intraop, postop, notes })
    if (piiError) {
      after(() => logAudit(userId, "PII_BLOCKED", id, { field: piiError.field, reason: piiError.reason }))
      return NextResponse.json(piiErrorBody(piiError), { status: 400 })
    }

    const transactionResult = await withLockedCaseTransaction(id, async tx => {
      const caseRecord = await tx.case.findUnique({
        where: { id },
        select: {
          userId: true,
          status: true,
          createdAt: true,
          institutionId: true,
          clinicalMode: true,
          clinicalRulesVersion: true,
        },
      })
      if (!caseRecord) throw new CaseWriteError("CASE_NOT_FOUND", 404, "Not found")
      if (!await canWriteCaseWithOwnerFallback(tx, user, caseRecord)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      if (caseRecord.status === "COMPLETE") {
        return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
      }

      const existingPreop = await tx.preoperativeAssessment.findUnique({ where: { caseId: id } })
      const existingIntraop = intraop
        ? await tx.intraoperativeRecord.findUnique({
            where: { caseId: id },
            select: {
              id: true,
              keyEvents: true,
              startedAt: true,
              startTime: true,
              createdAt: true,
              updatedAt: true,
              syncRevision: true,
            },
          })
        : null
      const existingPostop = postop
        ? await tx.postoperativeRecord.findUnique({ where: { caseId: id } })
        : null
      const existing = {
        ...caseRecord,
        preop: existingPreop,
        intraop: existingIntraop,
        postop: existingPostop,
      }
      const differentUser = existing.userId !== userId
      const requestedMode = clinicalMode ?? caseRecord.clinicalMode
      const enforceAgeDecision = clinicalMode !== undefined || (
        preop != null && (
          "ageYears" in preop
          || "ageValue" in preop
          || "ageUnit" in preop
        )
      )
      const pediatricDecision = decidePediatricWrite({
        clinicalMode: requestedMode,
        preop: preop as Record<string, unknown> | undefined,
        currentPreop: existingPreop as unknown as Record<string, unknown> | null,
        clientVersion,
        enforceAgeDecision,
        allowIncompleteAge: true,
      })
      if (!pediatricDecision.allowed) {
        return NextResponse.json({
          error: pediatricDecision.code,
          ...pediatricDecision,
        }, { status: pediatricDecision.status })
      }
      const preopTouched = preop != null || clinicalMode !== undefined
      const mappedPreop = preopTouched
        ? { ...(preop ?? {}), clinicalMode: pediatricDecision.clinicalMode }
        : null

      // Every conflict this save would hit, evaluated once.
      //
      // These used to be nine early returns each guarded by `!forceUpdate`, so
      // the flag did not merely skip the 409 -- it erased any record that there
      // had been a conflict at all. A colleague's edits were replaced with no
      // error, no warning, and nothing afterwards to show it had happened.
      //
      // Collecting them first keeps the same response (the first conflict wins,
      // in the same order) while leaving something to write down when the save
      // proceeds anyway.
      type DetectedConflict = {
        section: "preop" | "postop" | "intraop"
        reason?: "missing_conflict_timestamp"
        serverVersion: unknown
        clientRevision: number | null
        clientBase: string | null
        serverRevision: number | null
        serverUpdatedAt: string | null
      }
      const conflicts: DetectedConflict[] = []
      const at = (value: Date | null | undefined) => value?.toISOString() ?? null

      // Missing-timestamp guard stays scoped to different users: clients that
      // legitimately send no base header (fresh loads, older mobile flows) must
      // not 409 against their own case.
      if (differentUser && preopTouched && existing.preop && !preopBase) {
        conflicts.push({
          section: "preop", reason: "missing_conflict_timestamp",
          serverVersion: existing.preop,
          clientRevision: null, clientBase: null,
          serverRevision: existing.preop.syncRevision, serverUpdatedAt: at(existing.preop.updatedAt),
        })
      }
      if (differentUser && postop && existing.postop && !postopBase) {
        conflicts.push({
          section: "postop", reason: "missing_conflict_timestamp",
          serverVersion: existing.postop,
          clientRevision: null, clientBase: null,
          serverRevision: existing.postop.syncRevision, serverUpdatedAt: at(existing.postop.updatedAt),
        })
      }
      if (differentUser && intraop && existing.intraop && !intraopBase) {
        conflicts.push({
          section: "intraop", reason: "missing_conflict_timestamp",
          serverVersion: { updatedAt: existing.intraop.updatedAt },
          clientRevision: null, clientBase: null,
          serverRevision: existing.intraop.syncRevision, serverUpdatedAt: at(existing.intraop.updatedAt),
        })
      }

      // Stale-revision guard applies to EVERYONE: a client whose revision is
      // behind the server's conflicts even for the case owner's own writes --
      // the same user in two tabs or on two devices could otherwise silently
      // overwrite themselves.
      if (preopTouched && preopRevision != null && preopRevision !== "invalid" && existing.preop && existing.preop.syncRevision !== preopRevision) {
        conflicts.push({
          section: "preop", serverVersion: existing.preop,
          clientRevision: preopRevision, clientBase: preopBase,
          serverRevision: existing.preop.syncRevision, serverUpdatedAt: at(existing.preop.updatedAt),
        })
      }
      if (postop && postopRevision != null && postopRevision !== "invalid" && existing.postop && existing.postop.syncRevision !== postopRevision) {
        conflicts.push({
          section: "postop", serverVersion: existing.postop,
          clientRevision: postopRevision, clientBase: postopBase,
          serverRevision: existing.postop.syncRevision, serverUpdatedAt: at(existing.postop.updatedAt),
        })
      }
      if (intraop && intraopRevision != null && intraopRevision !== "invalid" && existing.intraop && existing.intraop.syncRevision !== intraopRevision) {
        conflicts.push({
          section: "intraop",
          serverVersion: { updatedAt: existing.intraop.updatedAt, revision: existing.intraop.syncRevision },
          clientRevision: intraopRevision, clientBase: intraopBase,
          serverRevision: existing.intraop.syncRevision, serverUpdatedAt: at(existing.intraop.updatedAt),
        })
      }

      // Stale-timestamp guard, for clients that send a base timestamp but no
      // revision.
      if (preopTouched && preopRevision == null && preopBase && existing.preop?.updatedAt && existing.preop.updatedAt.getTime() > new Date(preopBase).getTime()) {
        conflicts.push({
          section: "preop", serverVersion: existing.preop,
          clientRevision: null, clientBase: preopBase,
          serverRevision: existing.preop.syncRevision, serverUpdatedAt: at(existing.preop.updatedAt),
        })
      }
      if (postop && postopRevision == null && postopBase && existing.postop?.updatedAt && existing.postop.updatedAt.getTime() > new Date(postopBase).getTime()) {
        conflicts.push({
          section: "postop", serverVersion: existing.postop,
          clientRevision: null, clientBase: postopBase,
          serverRevision: existing.postop.syncRevision, serverUpdatedAt: at(existing.postop.updatedAt),
        })
      }
      if (intraop && intraopRevision == null && intraopBase && existing.intraop?.updatedAt && existing.intraop.updatedAt.getTime() > new Date(intraopBase).getTime()) {
        conflicts.push({
          section: "intraop", serverVersion: { updatedAt: existing.intraop.updatedAt },
          clientRevision: null, clientBase: intraopBase,
          serverRevision: existing.intraop.syncRevision, serverUpdatedAt: at(existing.intraop.updatedAt),
        })
      }

      if (conflicts.length && !overrideConflict) {
        const [first] = conflicts
        return NextResponse.json({
          error: "conflict",
          section: first.section,
          ...(first.reason ? { reason: first.reason } : {}),
          serverVersion: first.serverVersion,
        }, { status: 409 })
      }

    // Helper: compute the next status once, reused by both transaction and audit log
    function computeNextStatus(currentStatus: string): CaseStatus | undefined {
      const statusOrder: Record<string, number> = { DRAFT: 0, IN_PROGRESS: 1, AWAITING_REVIEW: 2, COMPLETE: 3 }
      let next: CaseStatus | undefined
      if (status !== undefined) {
        next = status
      } else if (intraop && currentStatus === "DRAFT" && intraop.startTime) {
        next = "IN_PROGRESS"
      } else if (postop && currentStatus === "IN_PROGRESS") {
        next = "AWAITING_REVIEW"
      }
      if (next && statusOrder[next] !== undefined && statusOrder[currentStatus] !== undefined) {
        if (statusOrder[next] < statusOrder[currentStatus]) next = undefined
      }
      return next
    }

      // The parent row is locked before this fresh read. Child-table triggers
      // acquire the same lock, so revision checks and all section/event writes
      // serialize with finalization even if a future caller bypasses this route.
    if (preopTouched && mappedPreop) {
      // Partial update: only touch fields present in the payload, so a stale
      // or partial save never wipes existing preop data. Create still uses
      // the full mapPreop (with defaults) for brand-new records.
      if (existing.preop) {
        const updated = await tx.preoperativeAssessment.updateMany({
          where: {
            caseId: id,
            ...(!overrideConflict && preopRevision != null && preopRevision !== "invalid"
              ? { syncRevision: preopRevision }
              : {}),
          },
          data: {
            ...mapPreopUpdate(mappedPreop, existingPreop as unknown as Record<string, unknown>),
            syncRevision: { increment: 1 },
          },
        })
        if (updated.count === 0) {
          const current = await tx.preoperativeAssessment.findUnique({ where: { caseId: id } })
          throw new CaseRouteResponse(NextResponse.json({
            error: "conflict",
            section: "preop",
            serverVersion: current,
          }, { status: 409 }))
        }
      } else {
        await tx.preoperativeAssessment.create({
          data: { caseId: id, ...mapPreop(mappedPreop), syncRevision: 1 },
        })
      }
    }
    if (intraop) {
      // The day this case belongs to, so a bare "HH:MM" plus the client's zone
      // can be resolved to a real instant. Taken from the record rather than
      // "now" — editing a case the morning after must not redate it.
      let effectiveIntraop: Record<string, unknown> = {
        caseDay: existing.intraop?.createdAt ?? existing.createdAt,
        ...intraop,
      }
      if ("timetableData" in intraop && intraop.timetableData) {
        const existingKev = (existing.intraop?.keyEvents as LegacyKeyEvents | null) ?? {}
        const existingLog: LogEvent[] = Array.isArray(existingKev.log) ? existingKev.log : []
        // Convert web-added clinicalEvents to log entries so mobile can see them
        const webCEs: ClinicalEvent[] = (intraop.timetableData as LegacyKeyEvents)?.clinicalEvents ?? []
        const logLabels = new Set(existingLog.filter(e => e.type === "clinical_event" || e.type === "event").map(e => e.label))
        let mergedLog = existingLog
        if (webCEs.length > 0 && existingLog.length > 0) {
          const sortedLog = [...existingLog].sort((a, b) => new Date(a.ts ?? 0).getTime() - new Date(b.ts ?? 0).getTime())
          const chartStartMs = existing.intraop?.startedAt?.getTime()
            ?? (sortedLog[0]?.ts ? new Date(sortedLog[0].ts).getTime() : null)
          if (chartStartMs) {
            const newEntries: LogEvent[] = webCEs
              .filter(ce => !logLabels.has(ce.label))
              .map(ce => ({
                id: `web-${ce.colIdx}-${ce.label}`,
                ts: intraopInstantForColumn(chartStartMs, ce.colIdx).toISOString(),
                type: "clinical_event",
                label: ce.label,
                color: ce.color,
              }))
            if (newEntries.length > 0) mergedLog = [...existingLog, ...newEntries]
          }
        }
        effectiveIntraop = { ...intraop, timetableData: { ...(intraop.timetableData as LegacyKeyEvents), log: mergedLog } }
      }
      if (existing.intraop) {
        const updated = await tx.intraoperativeRecord.updateMany({
          where: {
            caseId: id,
            ...(!overrideConflict && intraopRevision != null && intraopRevision !== "invalid"
              ? { syncRevision: intraopRevision }
              : {}),
          },
          data: { ...mapIntraopUpdate(effectiveIntraop), syncRevision: { increment: 1 } },
        })
        if (updated.count === 0) {
          const current = await tx.intraoperativeRecord.findUnique({ where: { caseId: id } })
          throw new CaseRouteResponse(NextResponse.json({
            error: "conflict",
            section: "intraop",
            serverVersion: current ? { updatedAt: current.updatedAt, revision: current.syncRevision } : undefined,
          }, { status: 409 }))
        }
      } else {
        await tx.intraoperativeRecord.create({
          data: { caseId: id, ...mapIntraop(effectiveIntraop), syncRevision: 1 },
        })
      }
      if ("timetableData" in effectiveIntraop && effectiveIntraop.timetableData) {
        const keyEvents = effectiveIntraop.timetableData as LegacyKeyEvents
        const savedTiming = await tx.intraoperativeRecord.findUnique({
          where: { caseId: id },
          select: { startedAt: true },
        })
        const start = savedTiming?.startedAt?.getTime() ?? null
        const eventRowCount = await tx.caseEvent.count({ where: { caseId: id } })
        let projectedLog = Array.isArray(keyEvents.log) && keyEvents.log.length > 0
          ? keyEvents.log
          : eventRowCount === 0
            ? snapshotLogForReconcile(keyEvents, start)
            : null
        // Bridge grid vitals from clients that don't emit vital events yet
        // (older cached web builds): any non-empty vitals column with no
        // vital event in that 5-minute bucket becomes one. Without this,
        // rebuildProjection (which rebuilds keyEvents purely from event rows)
        // silently wipes web-typed vitals as soon as the case has any events.
        const gridVitals = Array.isArray(keyEvents.vitals) ? keyEvents.vitals : []
        if (start !== null && gridVitals.length > 0 && projectedLog && projectedLog.length > 0) {
          const vitalCols = new Set(
            projectedLog
              .filter(e => e.type === "vital" && typeof e.ts === "string")
              .map(e => Math.floor((new Date(e.ts as string).getTime() - start) / INTRAOP_COLUMN_MS))
          )
          const bridged: LogEvent[] = []
          gridVitals.forEach((v, col) => {
            if (!v || typeof v !== "object") return
            if (!Object.values(v).some(x => x != null)) return
            if (vitalCols.has(col)) return
            bridged.push({
              id: `web-vital-${col}`,
              ts: intraopInstantForColumn(start, col).toISOString(),
              type: "vital",
              ...v,
            } as LogEvent)
          })
          if (bridged.length > 0) projectedLog = [...projectedLog, ...bridged]
        }
        if (projectedLog && projectedLog.length > 0) {
          // The third write path into CaseEvent, and the one a web client uses
          // most: saving the case saves the whole timetable. Without this a
          // drug charted here would store its ATC and no concept, while the
          // identical drug charted through the events endpoint stored both.
          await resolveDrugExposureConcepts(tx, projectedLog as unknown as Record<string, unknown>[])
          try {
            await reconcileFullLog(tx, id, userId, projectedLog, "web")
            await rebuildProjection(tx, id, { revisionAlreadyReserved: true })
          } catch (reconcileErr: unknown) {
            const code = (reconcileErr as { code?: string })?.code
            if (code !== "P2003" && code !== "P2025") throw reconcileErr
            console.warn("[PATCH /api/cases/:id] reconcileFullLog skipped — case deleted mid-save", code)
          }
        } else if (eventRowCount > 0) {
          await rebuildProjection(tx, id, { revisionAlreadyReserved: true })
        }
      }
    }
    if (postop) {
      // Partial update for existing records (see mapPreopUpdate rationale)
      if (existing.postop) {
        const updated = await tx.postoperativeRecord.updateMany({
          where: {
            caseId: id,
            ...(!overrideConflict && postopRevision != null && postopRevision !== "invalid"
              ? { syncRevision: postopRevision }
              : {}),
          },
          data: { ...mapPostopUpdate(postop), syncRevision: { increment: 1 } },
        })
        if (updated.count === 0) {
          const current = await tx.postoperativeRecord.findUnique({ where: { caseId: id } })
          throw new CaseRouteResponse(NextResponse.json({
            error: "conflict",
            section: "postop",
            serverVersion: current,
          }, { status: 409 }))
        }
      } else {
        await tx.postoperativeRecord.create({
          data: { caseId: id, ...mapPostop(postop), syncRevision: 1 },
        })
      }
    }

    if (
      pediatricDecision.clinicalMode !== caseRecord.clinicalMode
      || pediatricDecision.clinicalRulesVersion !== caseRecord.clinicalRulesVersion
    ) {
      await tx.case.update({
        where: { id },
        data: {
          clinicalMode: pediatricDecision.clinicalMode,
          clinicalRulesVersion: pediatricDecision.clinicalRulesVersion,
        },
      })
    }

    // Status transition rules:
    //   1. Explicit status in payload -> use as-is (e.g. final submit).
    //   2. No explicit status + intraop data + current DRAFT -> promote to IN_PROGRESS.
    //   3. No explicit status + postop data + current IN_PROGRESS -> promote to AWAITING_REVIEW
    //   4. Never implicitly demote a status
    //   COMPLETE requires POST /api/cases/:id/finalize (not allowed here)
    const finalStatus = computeNextStatus(existing.status)
    if (finalStatus) {
      await tx.case.update({
        where: { id },
        data: { status: finalStatus },
      })
    }
    if (notes !== undefined) {
      const sanitised = notes == null ? null : notes.trim().slice(0, 1000)
      await tx.case.update({ where: { id }, data: { notes: sanitised } })
    }

    const updatedCase = await tx.case.findUnique({
      where: { id },
      select: {
        updatedAt: true,
        finalizedAt: true,
        clinicalRevision: true,
        eventRevision: true,
        clinicalMode: true,
        clinicalRulesVersion: true,
        relationalRevision: true,
      },
    })
    const updatedPreop = await tx.preoperativeAssessment.findUnique({
      where: { caseId: id },
      select: { updatedAt: true, syncRevision: true },
    })
    const updatedPostop = await tx.postoperativeRecord.findUnique({
      where: { caseId: id },
      select: { updatedAt: true, syncRevision: true },
    })
    const updatedIntraop = await tx.intraoperativeRecord.findUnique({
      where: { caseId: id },
      select: { updatedAt: true, syncRevision: true },
    })
    const updated = updatedCase
      ? { ...updatedCase, preop: updatedPreop, postop: updatedPostop, intraop: updatedIntraop }
      : null
      // An override that actually overrode something is written down, in the
      // same transaction as the write it permitted. Previously the flag simply
      // skipped the 409 and left nothing behind, so a colleague's edits were
      // replaced with no error and no trace.
      //
      // The discarded values themselves are not copied here: they are clinical
      // data, and CaseFieldChange already holds the field-level history. What
      // this records is that an overwrite happened, to which sections, and
      // which version the client believed it was working from.
      if (conflicts.length) {
        await logAuditInTransaction(tx, userId, "CASE_CONFLICT_OVERRIDE", id, {
          sections: conflicts.map(conflict => ({
            section: conflict.section,
            reason: conflict.reason ?? "stale_revision",
            clientRevision: conflict.clientRevision,
            clientBase: conflict.clientBase,
            overriddenRevision: conflict.serverRevision,
            overriddenUpdatedAt: conflict.serverUpdatedAt,
          })),
        })
      }
      return { existing, finalStatus, updated }
    })

    if (transactionResult instanceof Response) return transactionResult
    const { existing, finalStatus, updated } = transactionResult

    after(() => logAudit(userId, "CASE_UPDATE", id, finalStatus ? { from: existing.status, to: finalStatus } : undefined))
    if (preop) after(() => writeFieldDiffsSafe(prisma, id, "preop", existing.preop ?? {}, preop, userId))
    if (postop) after(() => writeFieldDiffsSafe(prisma, id, "postop", existing.postop ?? {}, postop, userId))
    after(() => syncCaseRelationalLockedSafe(id, userId))
    // No in-process event emit here any more: clients poll
    // GET /api/cases/[id]/version, which works across serverless instances.

    return NextResponse.json({
      id,
      clinicalMode: updated?.clinicalMode,
      clinicalRulesVersion: updated?.clinicalRulesVersion,
      updatedAt: updated?.updatedAt,
      finalizedAt: updated?.finalizedAt,
      clinicalRevision: updated?.clinicalRevision,
      eventRevision: updated?.eventRevision,
      relationalRevision: updated?.relationalRevision,
      preopUpdatedAt: updated?.preop?.updatedAt,
      postopUpdatedAt: updated?.postop?.updatedAt,
      intraopUpdatedAt: updated?.intraop?.updatedAt,
      preopRevision: updated?.preop?.syncRevision,
      postopRevision: updated?.postop?.syncRevision,
      intraopRevision: updated?.intraop?.syncRevision,
      ...(rejectedFields.length ? { rejectedFields } : {}),
    })
  } catch (err: unknown) {
    if (err instanceof CaseRouteResponse) return err.response
    if (err instanceof CaseWriteError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    if (isCaseFinalizedDatabaseError(err)) {
      return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
    }
    if (err instanceof z.ZodError) {
      console.error("[PATCH /api/cases/:id] ZodError:", JSON.stringify(err.issues, null, 2))
      return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    }
    console.error("[PATCH /api/cases/:id]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = user.id
  const { id } = await params

  try {
    const result = await withLockedCaseTransaction(id, async tx => {
      const existing = await tx.case.findUnique({
        where: { id },
        select: { userId: true, status: true, institutionId: true, clinicalMode: true },
      })
      if (!existing) throw new CaseWriteError("CASE_NOT_FOUND", 404, "Not found")
      if (!await canWriteCaseWithOwnerFallback(tx, user, existing)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const pediatricBlock = pediatricMutationResponse(req, existing.clinicalMode)
      if (pediatricBlock) return pediatricBlock
      if (existing.status === "COMPLETE") {
        return NextResponse.json({ error: "Cannot delete a completed case" }, { status: 400 })
      }
      await tx.case.delete({ where: { id } })
      return null
    })
    if (result instanceof Response) return result
  } catch (err: unknown) {
    if (err instanceof CaseWriteError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error("[DELETE /api/cases/:id]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }

  after(() => logAudit(userId, "CASE_DELETE", id))
  return NextResponse.json({ ok: true })
}
