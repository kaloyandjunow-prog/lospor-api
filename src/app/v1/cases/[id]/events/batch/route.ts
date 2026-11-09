import { NextRequest, NextResponse, after } from "next/server"
import { z } from "zod"

import { getAuthUser } from "@/lib/mobile-auth"
import { clinicalEventSource } from "@/lib/event-provenance"
import { prisma } from "@/lib/prisma"
import { checkEventPII, piiErrorBody } from "@/lib/clinical-pii"
import { logAudit } from "@/lib/audit"
import {
  activeCaseLog,
  addEvent,
  cascadeDeleteIds,
  deleteEvent,
  laterChangeMade,
  madeAtFrom,
  rebuildProjection,
  reserveIntraopRevision,
  sameContent,
  timelineIssuesFor,
  type LogEvent,
} from "@/lib/case-events"
import { supersededRefusal, timelineRefusal } from "@/lib/timeline-refusal"
import { canWriteCaseWithOwnerFallback } from "@/lib/access-control"
import { resolveDrugExposureConcepts, syncCaseRelationalLockedSafe } from "@/lib/relational-sync"
import { corsHeaders } from "@/lib/cors"
import {
  CaseWriteError,
  isCaseFinalizedDatabaseError,
  withLockedCaseTransaction,
} from "@/lib/clinical-transaction"
import { pediatricMutationResponse } from "@/lib/pediatric-http"
import { caseEventWriteSchema } from "@/lib/case-event-schema"
import { atomicIntraopPatchFrom } from "@/lib/atomic-intraop-patch-input"
import { mapIntraop, mapIntraopUpdate } from "../../../_mappers"
import { rebaseAtomicIntraopPatch } from "@/lib/atomic-intraop-patch"
import { automationDuplicateClinicalEvent, automationTechniqueConflict, coalesceAutomationClinicalEvent } from "@/lib/automation-conflicts"

const CORS = (req: NextRequest) => corsHeaders(req, "POST, OPTIONS")

const batchSchema = z.object({
  add: z.array(caseEventWriteSchema).default([]),
  update: z.array(caseEventWriteSchema).default([]),
  remove: z.array(z.string().min(1).max(200)).default([]),
}).superRefine((value, ctx) => {
  if (value.add.length + value.update.length + value.remove.length === 0) {
    ctx.addIssue({ code: "custom", path: [], message: "At least one event operation is required" })
  }
  for (const [index, event] of value.update.entries()) {
    if (!event.id) ctx.addIssue({ code: "custom", path: ["update", index, "id"], message: "An update requires an event id" })
  }
})

function revisionFrom(req: NextRequest): number | null | "invalid" {
  const raw = req.headers.get("x-lospor-intraop-revision")
  if (raw == null) return null
  if (!/^\d+$/.test(raw)) return "invalid"
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : "invalid"
}

function conflict(intraop: { updatedAt: Date; syncRevision: number } | null) {
  return NextResponse.json({
    error: "conflict",
    section: "intraop",
    serverVersion: intraop
      ? { updatedAt: intraop.updatedAt, revision: intraop.syncRevision }
      : undefined,
  }, { status: 409 })
}

class BatchRouteResponse extends Error {
  constructor(readonly response: NextResponse) {
    super("EVENT_BATCH_ROUTE_RESPONSE")
  }
}

function batchError(error: unknown, caseId: string) {
  if (error instanceof CaseWriteError) return NextResponse.json({ error: error.message }, { status: error.status })
  if (isCaseFinalizedDatabaseError(error)) return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
  console.error("[events batch POST]", caseId, error)
  return NextResponse.json({ error: "Internal server error" }, { status: 500 })
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

/**
 * Apply a set of event-log operations under one case lock and one database
 * transaction. Context-link answers use this for the clinical event,
 * structured section patch and prompt answer that represent one clinician
 * action. Sending them individually could leave a clinically incomplete chart
 * after a network loss between requests.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const revision = revisionFrom(req)
  if (revision === "invalid") return NextResponse.json({ error: "Invalid intraop revision" }, { status: 400 })

  let parsed: z.infer<typeof batchSchema>
  try {
    parsed = batchSchema.parse(await req.json())
  } catch (error) {
    return NextResponse.json({
      error: "Invalid event batch",
      issues: error instanceof z.ZodError
        ? error.issues.map(issue => ({ field: issue.path.join("."), message: issue.message }))
        : [],
    }, { status: 400 })
  }

  const normalize = (event: z.infer<typeof caseEventWriteSchema>) => {
    let normalized: Record<string, unknown> = { ...event, id: event.id ?? crypto.randomUUID() }
    if (normalized.intraopPatch !== undefined) {
      const patch = atomicIntraopPatchFrom(normalized.intraopPatch)
      if (!patch.ok) throw new BatchRouteResponse(NextResponse.json(patch.body, { status: patch.status }))
      normalized = { ...normalized, intraopPatch: patch.patch }
    }
    const piiError = checkEventPII(normalized)
    if (piiError) throw new BatchRouteResponse(NextResponse.json(piiErrorBody(piiError), { status: 400 }))
    return normalized
  }

  let adds: Record<string, unknown>[]
  let updates: Record<string, unknown>[]
  try {
    adds = parsed.add.map(normalize)
    updates = parsed.update.map(normalize)
  } catch (error) {
    if (error instanceof BatchRouteResponse) return error.response
    throw error
  }
  const removes = [...new Set(parsed.remove)]
  const allEvents = [...adds, ...updates]
  await resolveDrugExposureConcepts(prisma, allEvents)
  const source = clinicalEventSource(user)
  const madeAt = madeAtFrom(req.headers.get("x-lospor-made-at"))

  try {
    const result = await withLockedCaseTransaction(id, async tx => {
      const caseRecord = await tx.case.findUnique({
        where: { id },
        select: { userId: true, status: true, institutionId: true, clinicalMode: true },
      })
      if (!caseRecord) throw new CaseWriteError("CASE_NOT_FOUND", 404, "Not found")
      if (!await canWriteCaseWithOwnerFallback(tx, user, caseRecord)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      if (caseRecord.status === "CANCELLED") return NextResponse.json({ error: "CASE_CANCELLED", code: "CASE_CANCELLED" }, { status: 409 })
      if (caseRecord.status === "COMPLETE") return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
      const pediatricBlock = pediatricMutationResponse(req, caseRecord.clinicalMode)
      if (pediatricBlock) return pediatricBlock

      const existingIntraop = await tx.intraoperativeRecord.findUnique({
        where: { caseId: id },
        select: {
          updatedAt: true, syncRevision: true,
          airwayDeviceEntries: true, airwayDevices: true, airwayTools: true,
          airwayNotApplicable: true, vascularAccesses: true,
          techniques: true, techniqueSides: true,
        },
      })
      const revisionConflictDetected = revision != null && !!existingIntraop && existingIntraop.syncRevision !== revision

      const current = await activeCaseLog(tx, id)
      // Validate context-link patches against the virtual record produced by
      // this whole batch, not one stale snapshot. Two contradictory answers
      // in one atomic request must not both pass and then be unioned by the
      // rebase helper.
      let virtualIntraop = (existingIntraop as unknown as Record<string, unknown> | null) ?? {}
      const eventsToWrite: LogEvent[] = []
      for (const raw of [...updates, ...adds]) {
        let candidate = raw as unknown as LogEvent
        const duplicate = automationDuplicateClinicalEvent([...current, ...eventsToWrite], candidate)
        if (duplicate) candidate = coalesceAutomationClinicalEvent(duplicate, candidate)
        if (candidate.intraopPatch && candidate.suggestion?.startsWith("context:")) {
          const techniqueConflict = automationTechniqueConflict(
            virtualIntraop,
            candidate.intraopPatch as Record<string, unknown>,
          )
          if (techniqueConflict) {
            return NextResponse.json({
              error: "automation_conflict",
              kind: techniqueConflict.kind,
              current: techniqueConflict.current,
              incoming: techniqueConflict.incoming,
            }, { status: 409 })
          }
          virtualIntraop = rebaseAtomicIntraopPatch(virtualIntraop, candidate.intraopPatch as Record<string, unknown>)
        }
        eventsToWrite.push(candidate)
      }
      const removeIds = new Set<string>()
      for (const eventId of removes) {
        for (const logicalId of cascadeDeleteIds(current, eventId)) removeIds.add(logicalId)
      }
      const deletedEvents = current.filter(event => typeof event.id === "string" && removeIds.has(event.id))
      const changedIds = new Set([
        ...[...updates, ...adds].map(event => String(event.id)),
        ...eventsToWrite.map(event => String(event.id)),
      ])
      for (const logicalId of [...removeIds, ...changedIds]) {
        if (await laterChangeMade(tx, id, logicalId, madeAt)) return supersededRefusal()
      }

      const next = [
        ...current.filter(event => {
          const eventId = event.id ?? ""
          return !removeIds.has(eventId) && !changedIds.has(eventId)
        }),
        ...eventsToWrite,
      ]
      const refused = timelineRefusal(timelineIssuesFor(current, next))
      if (refused) return refused

      const activeById = new Map<string, LogEvent>(current
        .filter(event => typeof event.id === "string")
        .map(event => [event.id as string, event] as const))
      const wouldChange = [...removeIds].some(logicalId => activeById.has(logicalId))
        || eventsToWrite.some(event => {
          const currentEvent = activeById.get(String(event.id))
          return currentEvent == null || !sameContent(currentEvent as unknown as Record<string, unknown>, event as unknown as Record<string, unknown>)
        })
      // A retry of a batch that was already committed is a no-op even if the
      // caller still holds the older revision. A stale revision must still
      // block a genuinely new batch, preserving the all-or-nothing contract.
      if (revisionConflictDetected && wouldChange) return conflict(existingIntraop)
      const revisionReserved = wouldChange && revision != null && !!existingIntraop
      if (revisionReserved && !await reserveIntraopRevision(tx, id, revision)) {
        const fresh = await tx.intraoperativeRecord.findUnique({
          where: { caseId: id },
          select: { updatedAt: true, syncRevision: true },
        })
        return conflict(fresh)
      }

      let changed = false
      if (wouldChange) for (const logicalId of removeIds) {
        if (await deleteEvent(tx, id, logicalId, madeAt)) changed = true
      }
      if (wouldChange) for (const clinicalEvent of eventsToWrite) {
        const eventChanged = await addEvent(tx, id, user.id, clinicalEvent, source, madeAt)
        if (!eventChanged) continue
        changed = true
        const patch = clinicalEvent.intraopPatch
        if (patch && typeof patch === "object" && Object.keys(patch).length > 0) {
          const record = await tx.intraoperativeRecord.findUnique({
            where: { caseId: id },
            select: {
              airwayDeviceEntries: true, airwayDevices: true, airwayTools: true,
              airwayNotApplicable: true, vascularAccesses: true,
              techniques: true, techniqueSides: true,
            },
          })
          const rebased = rebaseAtomicIntraopPatch((record ?? {}) as Record<string, unknown>, patch as Record<string, unknown>)
          const mapped = mapIntraopUpdate(rebased)
          if (Object.keys(mapped).length > 0) {
            if (record) await tx.intraoperativeRecord.update({ where: { caseId: id }, data: mapped })
            else await tx.intraoperativeRecord.create({ data: { caseId: id, ...mapIntraop(rebased) } })
          }
        }
      }
      if (changed) {
        await rebuildProjection(tx, id, { revisionAlreadyReserved: revisionReserved, deletedEvents })
        if (caseRecord.status === "DRAFT") await tx.case.update({ where: { id }, data: { status: "IN_PROGRESS" } })
      }
      const intraop = await tx.intraoperativeRecord.findUnique({
        where: { caseId: id },
        select: { updatedAt: true, syncRevision: true },
      })
      return { changed, intraop }
    })

    if (result instanceof Response) return result
    if (result.changed) {
      after(() => logAudit(user.id, "CASE_EVENT_ADD", id, {
        added: adds.length, updated: updates.length, removed: removes.length, source,
      }))
      if ([...adds, ...updates].some(event => event.type === "complication") || removes.length > 0) {
        after(() => syncCaseRelationalLockedSafe(id, user.id))
      }
    }
    return NextResponse.json({
      ok: true,
      intraopUpdatedAt: result.intraop?.updatedAt,
      intraopRevision: result.intraop?.syncRevision,
    })
  } catch (error: unknown) {
    return batchError(error, id)
  }
}
