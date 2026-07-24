import { NextRequest, NextResponse, after } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { mapPreop, mapPreopUpdate, mapIntraop, mapIntraopUpdate, mapPostop, mapPostopUpdate } from "../_mappers"
import { z } from "zod"
import { logAudit } from "@/lib/audit"
import { preopSchema, intraopSchema, postopSchema } from "@/lib/schemas/case"
import { parseLenient } from "@/lib/lenient-parse"
import { checkClinicalPayloadPII, piiErrorBody } from "@/lib/clinical-pii"
import { syncCaseRelationalSafe } from "@/lib/relational-sync"
import { writeFieldDiffsSafe } from "@/lib/case-audit"
import { rebuildProjection, reconcileFullLog, snapshotLogForReconcile } from "@/lib/case-events"
import { canAccessCase, caseWhereForUser } from "@/lib/access-control"
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

const CORS = (req: NextRequest) => corsHeaders(req)
const REVISION_HEADER = SECTION_REVISION_HEADER

function readRevision(req: NextRequest, section: keyof typeof REVISION_HEADER): number | null | "invalid" {
  const raw = req.headers.get(REVISION_HEADER[section])
  if (raw == null) return null
  if (!/^\d+$/.test(raw)) return "invalid"
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : "invalid"
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
  postop:      postopSchema.optional(),
  forceUpdate: z.boolean().optional(),
})

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const where = caseWhereForUser(user, id)

  const record = await prisma.case.findFirst({
    where,
    include: {
      preop: true,
      intraop: true,
      postop: true,
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
  const normalizedRecord = record.intraop && Array.isArray(record.intraop.techniques)
    ? {
        ...record,
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
    : record
  // Prisma JSON columns are intentionally broad at the persistence boundary.
  // The response contract is the shared serialised CaseDetail shape.
  const responseRecord = normalizedRecord as unknown as Serialized<CaseDetail>

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

  const existing = await prisma.case.findUnique({
    where: { id },
    select: {
      userId: true, status: true, createdAt: true,
      user:   { select: { institutionId: true } },
      preop:  true,
      intraop: { select: { id: true, keyEvents: true, startedAt: true, startTime: true, createdAt: true, updatedAt: true, syncRevision: true } },
      postop:  true,
    },
  })
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!canAccessCase(user, existing))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (existing.status === "COMPLETE") return NextResponse.json({ error: "Case is finalised" }, { status: 403 })

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
    const { preop, intraop, postop, status, notes, forceUpdate: forceUpdateField } = body
    const preopBase = req.headers.get("x-lospor-preop-updated-at")
    const postopBase = req.headers.get("x-lospor-postop-updated-at")
    const intraopBase = req.headers.get("x-lospor-intraop-updated-at")
    const preopRevision = readRevision(req, "preop")
    const postopRevision = readRevision(req, "postop")
    const intraopRevision = readRevision(req, "intraop")
    const forceUpdate = req.headers.get("x-lospor-force-update") === "true" ||
      forceUpdateField === true

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

    const differentUser = existing.userId !== userId
    // Missing-timestamp guard stays scoped to different users: clients that
    // legitimately send no base header (fresh loads, older mobile flows) must
    // not 409 against their own case.
    if (!forceUpdate && differentUser && preop && existing.preop && !preopBase) {
      return NextResponse.json({
        error: "conflict",
        section: "preop",
        reason: "missing_conflict_timestamp",
        serverVersion: existing.preop,
      }, { status: 409 })
    }
    if (!forceUpdate && differentUser && postop && existing.postop && !postopBase) {
      return NextResponse.json({
        error: "conflict",
        section: "postop",
        reason: "missing_conflict_timestamp",
        serverVersion: existing.postop,
      }, { status: 409 })
    }
    if (!forceUpdate && differentUser && intraop && existing.intraop && !intraopBase) {
      return NextResponse.json({
        error: "conflict",
        section: "intraop",
        reason: "missing_conflict_timestamp",
        serverVersion: { updatedAt: existing.intraop.updatedAt },
      }, { status: 409 })
    }

    // Stale-timestamp guard applies to EVERYONE (v5): a client whose base
    // timestamp is older than the server's gets a 409 even for the case
    // owner's own writes — the same user in two tabs/devices could previously
    // silently overwrite themselves. Clients self-heal via the shared
    // conflict-retry engine or surface the conflict-resolution UI.
    if (!forceUpdate && preop && preopRevision != null && preopRevision !== "invalid" && existing.preop && existing.preop.syncRevision !== preopRevision) {
      return NextResponse.json({
        error: "conflict",
        section: "preop",
        serverVersion: existing.preop,
      }, { status: 409 })
    }
    if (!forceUpdate && postop && postopRevision != null && postopRevision !== "invalid" && existing.postop && existing.postop.syncRevision !== postopRevision) {
      return NextResponse.json({
        error: "conflict",
        section: "postop",
        serverVersion: existing.postop,
      }, { status: 409 })
    }
    if (!forceUpdate && intraop && intraopRevision != null && intraopRevision !== "invalid" && existing.intraop && existing.intraop.syncRevision !== intraopRevision) {
      return NextResponse.json({
        error: "conflict",
        section: "intraop",
        serverVersion: { updatedAt: existing.intraop.updatedAt, revision: existing.intraop.syncRevision },
      }, { status: 409 })
    }
    if (!forceUpdate && preop && preopRevision == null && preopBase && existing.preop?.updatedAt && existing.preop.updatedAt.getTime() > new Date(preopBase).getTime()) {
      return NextResponse.json({
        error: "conflict",
        section: "preop",
        serverVersion: existing.preop,
      }, { status: 409 })
    }
    if (!forceUpdate && postop && postopRevision == null && postopBase && existing.postop?.updatedAt && existing.postop.updatedAt.getTime() > new Date(postopBase).getTime()) {
      return NextResponse.json({
        error: "conflict",
        section: "postop",
        serverVersion: existing.postop,
      }, { status: 409 })
    }
    if (!forceUpdate && intraop && intraopRevision == null && intraopBase && existing.intraop?.updatedAt && existing.intraop.updatedAt.getTime() > new Date(intraopBase).getTime()) {
      return NextResponse.json({
        error: "conflict",
        section: "intraop",
        serverVersion: { updatedAt: existing.intraop.updatedAt },
      }, { status: 409 })
    }

    const piiError = checkClinicalPayloadPII({ preop, intraop, postop, notes })
    if (piiError) {
      after(() => logAudit(userId, "PII_BLOCKED", id, { field: piiError.field, reason: piiError.reason }))
      return NextResponse.json(piiErrorBody(piiError), { status: 400 })
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

    // Conflict detection is done above (lines ~130-150) using the pre-read `existing`
    // record. We do NOT re-read inside a transaction here because Supabase's
    // Transaction-mode PgBouncer (port 6543) cannot sustain interactive transactions
    // across multiple statements → P2028. The outer check already catches the
    // overwhelming majority of conflicts; the sub-millisecond race window that a
    // true serialised transaction would close is acceptable for clinical charting.
    if (preop) {
      // Partial update: only touch fields present in the payload, so a stale
      // or partial save never wipes existing preop data. Create still uses
      // the full mapPreop (with defaults) for brand-new records.
      if (existing.preop) {
        const updated = await prisma.preoperativeAssessment.updateMany({
          where: {
            caseId: id,
            ...(!forceUpdate && preopRevision != null && preopRevision !== "invalid"
              ? { syncRevision: preopRevision }
              : {}),
          },
          data: { ...mapPreopUpdate(preop), syncRevision: { increment: 1 } },
        })
        if (updated.count === 0) {
          const current = await prisma.preoperativeAssessment.findUnique({ where: { caseId: id } })
          return NextResponse.json({
            error: "conflict",
            section: "preop",
            serverVersion: current,
          }, { status: 409 })
        }
      } else {
        await prisma.preoperativeAssessment.create({
          data: { caseId: id, ...mapPreop(preop), syncRevision: 1 },
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
        const updated = await prisma.intraoperativeRecord.updateMany({
          where: {
            caseId: id,
            ...(!forceUpdate && intraopRevision != null && intraopRevision !== "invalid"
              ? { syncRevision: intraopRevision }
              : {}),
          },
          data: { ...mapIntraopUpdate(effectiveIntraop), syncRevision: { increment: 1 } },
        })
        if (updated.count === 0) {
          const current = await prisma.intraoperativeRecord.findUnique({ where: { caseId: id } })
          return NextResponse.json({
            error: "conflict",
            section: "intraop",
            serverVersion: current ? { updatedAt: current.updatedAt, revision: current.syncRevision } : undefined,
          }, { status: 409 })
        }
      } else {
        await prisma.intraoperativeRecord.create({
          data: { caseId: id, ...mapIntraop(effectiveIntraop), syncRevision: 1 },
        })
      }
      if ("timetableData" in effectiveIntraop && effectiveIntraop.timetableData) {
        const keyEvents = effectiveIntraop.timetableData as LegacyKeyEvents
        const savedTiming = await prisma.intraoperativeRecord.findUnique({
          where: { caseId: id },
          select: { startedAt: true },
        })
        const start = savedTiming?.startedAt?.getTime() ?? null
        const eventRowCount = await prisma.caseEvent.count({ where: { caseId: id } })
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
          try {
            await reconcileFullLog(prisma, id, userId, projectedLog, "web")
            await rebuildProjection(prisma, id, { revisionAlreadyReserved: true })
          } catch (reconcileErr: unknown) {
            const code = (reconcileErr as { code?: string })?.code
            if (code !== "P2003" && code !== "P2025") throw reconcileErr
            console.warn("[PATCH /api/cases/:id] reconcileFullLog skipped — case deleted mid-save", code)
          }
        } else if (eventRowCount > 0) {
          await rebuildProjection(prisma, id, { revisionAlreadyReserved: true })
        }
      }
    }
    if (postop) {
      // Partial update for existing records (see mapPreopUpdate rationale)
      if (existing.postop) {
        const updated = await prisma.postoperativeRecord.updateMany({
          where: {
            caseId: id,
            ...(!forceUpdate && postopRevision != null && postopRevision !== "invalid"
              ? { syncRevision: postopRevision }
              : {}),
          },
          data: { ...mapPostopUpdate(postop), syncRevision: { increment: 1 } },
        })
        if (updated.count === 0) {
          const current = await prisma.postoperativeRecord.findUnique({ where: { caseId: id } })
          return NextResponse.json({
            error: "conflict",
            section: "postop",
            serverVersion: current,
          }, { status: 409 })
        }
      } else {
        await prisma.postoperativeRecord.create({
          data: { caseId: id, ...mapPostop(postop), syncRevision: 1 },
        })
      }
    }

    if (preop || intraop || postop) {
      // Direct child-table updates above provide atomic revision checks. Keep
      // the parent case clock moving for dashboard/version consumers.
      await prisma.case.update({ where: { id }, data: { updatedAt: new Date() } })
    }

    // Status transition rules:
    //   1. Explicit status in payload -> use as-is (e.g., final submit sends "COMPLETE")
    //   2. No explicit status + intraop data + current DRAFT -> promote to IN_PROGRESS
    //   3. No explicit status + postop data + current IN_PROGRESS -> promote to AWAITING_REVIEW
    //   4. Never implicitly demote a status
    //   COMPLETE requires POST /api/cases/:id/finalize (not allowed here)
    const finalStatus = computeNextStatus(existing.status)
    if (finalStatus) {
      await prisma.case.update({
        where: { id },
        data: { status: finalStatus },
      })
    }
    if (notes !== undefined) {
      const sanitised = notes == null ? null : notes.trim().slice(0, 1000)
      await prisma.case.update({ where: { id }, data: { notes: sanitised } })
    }

    after(() => logAudit(userId, "CASE_UPDATE", id, finalStatus ? { from: existing.status, to: finalStatus } : undefined))
    if (preop)  after(() => writeFieldDiffsSafe(prisma, id, "preop",  existing.preop  ?? {}, preop,  userId))
    if (postop) after(() => writeFieldDiffsSafe(prisma, id, "postop", existing.postop ?? {}, postop, userId))
    after(() => syncCaseRelationalSafe(prisma, id, userId))
    // No in-process event emit here any more: clients poll
    // GET /api/cases/[id]/version, which works across serverless instances.

    const updated = await prisma.case.findUnique({
      where: { id },
      select: {
        updatedAt: true,
        finalizedAt: true,
        preop:   { select: { updatedAt: true, syncRevision: true } },
        postop:  { select: { updatedAt: true, syncRevision: true } },
        intraop: { select: { updatedAt: true, syncRevision: true } },
      },
    })

    return NextResponse.json({
      id,
      updatedAt: updated?.updatedAt,
      finalizedAt: updated?.finalizedAt,
      preopUpdatedAt: updated?.preop?.updatedAt,
      postopUpdatedAt: updated?.postop?.updatedAt,
      intraopUpdatedAt: updated?.intraop?.updatedAt,
      preopRevision: updated?.preop?.syncRevision,
      postopRevision: updated?.postop?.syncRevision,
      intraopRevision: updated?.intraop?.syncRevision,
      // Present only when something was refused — the client must tell the user
      // rather than let them believe an out-of-range value was stored.
      ...(rejectedFields.length ? { rejectedFields } : {}),
    })
  } catch (err: unknown) {
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

  const existing = await prisma.case.findUnique({
    where: { id },
    select: { userId: true, status: true, user: { select: { institutionId: true } } },
  })
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!canAccessCase(user, existing))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (existing.status === "COMPLETE") return NextResponse.json({ error: "Cannot delete a completed case" }, { status: 400 })

  await prisma.case.delete({ where: { id } })
  after(() => logAudit(userId, "CASE_DELETE", id))
  return NextResponse.json({ ok: true })
}
