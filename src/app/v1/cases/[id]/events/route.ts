import { NextRequest, NextResponse, after } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { clinicalEventSource } from "@/lib/event-provenance"
import { prisma } from "@/lib/prisma"
import { checkEventPII, piiErrorBody, type ClinicalPiiIssue } from "@/lib/clinical-pii"
import { logAudit } from "@/lib/audit"
import { addEvent, reconcileFullLog, rebuildProjection, reserveIntraopRevision, type LogEvent } from "@/lib/case-events"
import { canWriteCaseWithOwnerFallback } from "@/lib/access-control"
import { resolveDrugExposureConcepts } from "@/lib/relational-sync"
import { corsHeaders } from "@/lib/cors"
import {
  CaseWriteError,
  isCaseFinalizedDatabaseError,
  withLockedCaseTransaction,
} from "@/lib/clinical-transaction"
import { z } from "zod"

import { pediatricMutationResponse } from "@/lib/pediatric-http"
import { caseEventWriteSchema } from "@/lib/case-event-schema"
const CORS = (req: NextRequest) => corsHeaders(req, "POST, PUT, OPTIONS")

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

// Permissive event schema — known fields typed, unknown ones (color, infId,
// fluidId, etc.) passed through so the timetable projection still sees them.
const MAX_LOG_ENTRIES = 20_000

const eventSchema = caseEventWriteSchema

// Free-text fields a user can type — these get the same PII guard as the rest of
// the clinical write paths. Vitals/numbers are not user prose, so they're skipped.
function piiForEvent(ev: { name?: unknown; label?: unknown }): ClinicalPiiIssue | null {
  return checkEventPII(ev)
}

function revisionFrom(req: NextRequest): number | null | "invalid" {
  const raw = req.headers.get("x-lospor-intraop-revision")
  if (raw == null) return null
  if (!/^\d+$/.test(raw)) return "invalid"
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : "invalid"
}

function revisionConflict(intraop: { updatedAt: Date; syncRevision: number } | null) {
  return NextResponse.json({
    error: "conflict",
    section: "intraop",
    serverVersion: intraop
      ? { updatedAt: intraop.updatedAt, revision: intraop.syncRevision }
      : undefined,
  }, { status: 409 })
}

class EventRouteResponse extends Error {
  constructor(readonly response: NextResponse) {
    super("EVENT_ROUTE_RESPONSE")
  }
}

function eventWriteError(error: unknown, operation: "POST" | "PUT", caseId: string) {
  if (error instanceof EventRouteResponse) return error.response
  if (error instanceof CaseWriteError) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }
  if (isCaseFinalizedDatabaseError(error)) {
    return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
  }
  console.error(`[events ${operation}]`, caseId, error)
  return NextResponse.json({ error: "Internal server error" }, { status: 500 })
}

// POST — append one event. The parent case lock covers the source rows, the
// timetable projection, and the lifecycle promotion as one atomic change.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params

  const revision = revisionFrom(req)
  if (revision === "invalid") return NextResponse.json({ error: "Invalid intraop revision" }, { status: 400 })

  let event: z.infer<typeof eventSchema>
  try {
    event = eventSchema.parse(await req.json())
  } catch {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 })
  }
  if (!event.id) event.id = crypto.randomUUID()

  const piiError = piiForEvent(event)
  if (piiError) return NextResponse.json(piiErrorBody(piiError), { status: 400 })

  // Drug vocabulary lookup is read-only and does not need to hold the case lock.
  if (event.type === "drug" && event.atcCode && !event.drugId) {
    const drug = await prisma.drug.findFirst({
      where: { atcCode: String(event.atcCode) },
      select: { id: true },
    })
    if (drug) event.drugId = drug.id
  }

  // Resolve the standard concept once, here, rather than on every export.
  // Preop medications have always stored theirs; intraoperative drugs did not,
  // so every drug given during a case exported as unmapped even when its ATC
  // was known. Resolved through the same helper the medication path uses, so
  // the same drug cannot map differently depending on which screen recorded it.
  await resolveDrugExposureConcepts(prisma, [event as Record<string, unknown>])

  const source = clinicalEventSource(user)
  try {
    const result = await withLockedCaseTransaction(id, async tx => {
      const caseRecord = await tx.case.findUnique({
        where: { id },
        select: { userId: true, status: true, institutionId: true, clinicalMode: true },
      })
      if (!caseRecord) throw new CaseWriteError("CASE_NOT_FOUND", 404, "Not found")
      if (!await canWriteCaseWithOwnerFallback(tx, user, caseRecord)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      if (caseRecord.status === "COMPLETE") {
        return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
      }
      const pediatricBlock = pediatricMutationResponse(req, caseRecord.clinicalMode)
      if (pediatricBlock) return pediatricBlock
      const existingIntraop = await tx.intraoperativeRecord.findUnique({
        where: { caseId: id },
        select: { updatedAt: true, syncRevision: true },
      })
      const existing = { ...caseRecord, intraop: existingIntraop }
      if (revision != null && existing.intraop && existing.intraop.syncRevision !== revision) {
        return revisionConflict(existing.intraop)
      }

      const revisionReserved = revision != null && !!existing.intraop
      if (revisionReserved && !await reserveIntraopRevision(tx, id, revision)) {
        const fresh = await tx.intraoperativeRecord.findUnique({
          where: { caseId: id },
          select: { updatedAt: true, syncRevision: true },
        })
        throw new EventRouteResponse(revisionConflict(fresh))
      }

      const added = await addEvent(tx, id, user.id, event as unknown as LogEvent, source)
      await rebuildProjection(tx, id, { revisionAlreadyReserved: revisionReserved })
      if (existing.status === "DRAFT") {
        await tx.case.update({ where: { id }, data: { status: "IN_PROGRESS" } })
      }
      const intraop = await tx.intraoperativeRecord.findUnique({
        where: { caseId: id },
        select: { updatedAt: true, syncRevision: true },
      })
      return { added, intraop }
    })

    if (result instanceof Response) return result
    if (result.added) {
      after(() => logAudit(user.id, "CASE_EVENT_ADD", id, { type: event.type, source }))
    }
    return NextResponse.json({
      ok: true,
      id: event.id,
      intraopUpdatedAt: result.intraop?.updatedAt,
      intraopRevision: result.intraop?.syncRevision,
    })
  } catch (error: unknown) {
    return eventWriteError(error, "POST", id)
  }
}

// PUT — reconcile the client's full desired log into versioned source rows and
// rebuild the legacy projection in the same locked transaction.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const source = clinicalEventSource(user)

  const body = await req.json().catch(() => null)
  const rawLog = body?.log
  if (!Array.isArray(rawLog)) return NextResponse.json({ error: "log must be array" }, { status: 400 })
  if (rawLog.length > MAX_LOG_ENTRIES) {
    return NextResponse.json(
      { error: `log too large (${rawLog.length} entries, maximum ${MAX_LOG_ENTRIES})` },
      { status: 413 },
    )
  }

  const intraopBase = req.headers.get("x-lospor-intraop-updated-at")
  const revisionRaw = req.headers.get("x-lospor-intraop-revision")
  const intraopRevision = revisionRaw == null
    ? null
    : /^\d+$/.test(revisionRaw) && Number.isSafeInteger(Number(revisionRaw))
      ? Number(revisionRaw)
      : "invalid"
  if (intraopRevision === "invalid") {
    return NextResponse.json({ error: "Invalid intraop revision" }, { status: 400 })
  }
  if (intraopBase && Number.isNaN(new Date(intraopBase).getTime())) {
    return NextResponse.json({ error: "Invalid intraop conflict timestamp" }, { status: 400 })
  }

  let log: z.infer<typeof eventSchema>[]
  try {
    log = rawLog.map(entry => eventSchema.parse(entry))
  } catch {
    return NextResponse.json({ error: "Invalid event in log" }, { status: 400 })
  }
  for (const event of log) {
    const piiError = piiForEvent(event)
    if (piiError) return NextResponse.json(piiErrorBody(piiError), { status: 400 })
  }
  // Same resolution the single-event POST does. Reconciling a whole log used
  // to skip it entirely, so whether a drug arrived with a concept depended on
  // which of the two endpoints the client happened to use to send it.
  // Read-only, and outside the case lock for the same reason POST's is.
  await resolveDrugExposureConcepts(prisma, log as unknown as Record<string, unknown>[])

  try {
    const result = await withLockedCaseTransaction(id, async tx => {
      const caseRecord = await tx.case.findUnique({
        where: { id },
        select: { userId: true, status: true, institutionId: true, clinicalMode: true },
      })
      if (!caseRecord) throw new CaseWriteError("CASE_NOT_FOUND", 404, "Not found")
      if (!await canWriteCaseWithOwnerFallback(tx, user, caseRecord)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      if (caseRecord.status === "COMPLETE") {
        return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
      }
      const pediatricBlock = pediatricMutationResponse(req, caseRecord.clinicalMode)
      if (pediatricBlock) return pediatricBlock
      const existingIntraop = await tx.intraoperativeRecord.findUnique({
        where: { caseId: id },
        select: { updatedAt: true, syncRevision: true },
      })
      const existing = { ...caseRecord, intraop: existingIntraop }
      if (intraopRevision == null && !intraopBase && existing.intraop?.updatedAt) {
        return NextResponse.json({
          error: "conflict",
          section: "intraop",
          reason: "missing_conflict_timestamp",
          serverVersion: {
            updatedAt: existing.intraop.updatedAt,
            revision: existing.intraop.syncRevision,
          },
        }, { status: 409 })
      }
      if (intraopRevision != null && existing.intraop && existing.intraop.syncRevision !== intraopRevision) {
        return revisionConflict(existing.intraop)
      }
      if (
        intraopRevision == null &&
        intraopBase &&
        existing.intraop?.updatedAt &&
        existing.intraop.updatedAt.getTime() > new Date(intraopBase).getTime()
      ) {
        return revisionConflict(existing.intraop)
      }

      const revisionReserved = intraopRevision != null && !!existing.intraop
      if (revisionReserved && !await reserveIntraopRevision(tx, id, intraopRevision)) {
        const fresh = await tx.intraoperativeRecord.findUnique({
          where: { caseId: id },
          select: { updatedAt: true, syncRevision: true },
        })
        throw new EventRouteResponse(revisionConflict(fresh))
      }

      await reconcileFullLog(tx, id, user.id, log as unknown as LogEvent[], source)
      await rebuildProjection(tx, id, { revisionAlreadyReserved: revisionReserved })
      const intraop = await tx.intraoperativeRecord.findUnique({
        where: { caseId: id },
        select: { updatedAt: true, syncRevision: true },
      })
      return { intraop }
    })

    if (result instanceof Response) return result
    after(() => logAudit(user.id, "CASE_EVENT_EDIT", id, { count: log.length, source }))
    return NextResponse.json({
      ok: true,
      intraopUpdatedAt: result.intraop?.updatedAt,
      intraopRevision: result.intraop?.syncRevision,
    })
  } catch (error: unknown) {
    return eventWriteError(error, "PUT", id)
  }
}
