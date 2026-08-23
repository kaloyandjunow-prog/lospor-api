import { NextRequest, NextResponse, after } from "next/server"
import { z } from "zod"

import { canWriteCaseWithOwnerFallback } from "@/lib/access-control"
import { logAudit } from "@/lib/audit"
import { addEvent, deleteEvent, rebuildProjection, reserveIntraopRevision, type LogEvent } from "@/lib/case-events"
import { checkEventPII, piiErrorBody } from "@/lib/clinical-pii"
import { corsHeaders } from "@/lib/cors"
import {
  CaseWriteError,
  isCaseFinalizedDatabaseError,
  withLockedCaseTransaction,
} from "@/lib/clinical-transaction"
import { getAuthUser } from "@/lib/mobile-auth"
import { clinicalEventSource } from "@/lib/event-provenance"

import { pediatricMutationResponse } from "@/lib/pediatric-http"
import { caseEventWriteSchema } from "@/lib/case-event-schema"
const CORS = (req: NextRequest) => corsHeaders(req, "PUT, DELETE, OPTIONS")

// The path id remains authoritative (`{ ...parsed, id: eventId }` below).
// Reuse the refined canonical schema directly: Zod cannot `.omit()` a schema
// after `superRefine`, and accepting an ignored body id is backwards-compatible.
const eventSchema = caseEventWriteSchema

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

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

function eventItemError(error: unknown, operation: "PUT" | "DELETE", caseId: string) {
  if (error instanceof CaseWriteError) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }
  if (isCaseFinalizedDatabaseError(error)) {
    return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
  }
  console.error(`[event ${operation}]`, caseId, error)
  return NextResponse.json({ error: "Internal server error" }, { status: 500 })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id, eventId } = await params
  const source = clinicalEventSource(user)
  const revision = revisionFrom(req)
  if (revision === "invalid") return NextResponse.json({ error: "Invalid intraop revision" }, { status: 400 })

  let parsed: z.infer<typeof eventSchema>
  try {
    parsed = eventSchema.parse(await req.json())
  } catch {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 })
  }
  const event = { ...parsed, id: eventId }
  const piiError = checkEventPII(event)
  if (piiError) return NextResponse.json(piiErrorBody(piiError), { status: 400 })

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
        return conflict(existing.intraop)
      }

      const revisionReserved = revision != null && !!existing.intraop
      if (revisionReserved && !await reserveIntraopRevision(tx, id, revision)) {
        const fresh = await tx.intraoperativeRecord.findUnique({
          where: { caseId: id },
          select: { updatedAt: true, syncRevision: true },
        })
        return conflict(fresh)
      }
      await addEvent(tx, id, user.id, event as LogEvent, source)
      await rebuildProjection(tx, id, { revisionAlreadyReserved: revisionReserved })
      const fresh = await tx.intraoperativeRecord.findUnique({
        where: { caseId: id },
        select: { updatedAt: true, syncRevision: true },
      })
      return { fresh }
    })

    if (result instanceof Response) return result
    after(() => logAudit(user.id, "CASE_EVENT_EDIT", id, { eventId, source }))
    return NextResponse.json({
      ok: true,
      intraopUpdatedAt: result.fresh?.updatedAt,
      intraopRevision: result.fresh?.syncRevision,
    })
  } catch (error: unknown) {
    return eventItemError(error, "PUT", id)
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id, eventId } = await params
  const source = clinicalEventSource(user)
  const revision = revisionFrom(req)
  if (revision === "invalid") return NextResponse.json({ error: "Invalid intraop revision" }, { status: 400 })

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
      const existingIntraop = await tx.intraoperativeRecord.findUnique({
        where: { caseId: id },
        select: { updatedAt: true, syncRevision: true },
      })
      const existing = { ...caseRecord, intraop: existingIntraop }
      const pediatricBlock = pediatricMutationResponse(req, caseRecord.clinicalMode)
      if (pediatricBlock) return pediatricBlock
      if (revision != null && existing.intraop && existing.intraop.syncRevision !== revision) {
        return conflict(existing.intraop)
      }

      const revisionReserved = revision != null && !!existing.intraop
      if (revisionReserved && !await reserveIntraopRevision(tx, id, revision)) {
        const fresh = await tx.intraoperativeRecord.findUnique({
          where: { caseId: id },
          select: { updatedAt: true, syncRevision: true },
        })
        return conflict(fresh)
      }
      const removed = await deleteEvent(tx, id, eventId)
      if (removed) await rebuildProjection(tx, id, { revisionAlreadyReserved: revisionReserved })
      const fresh = await tx.intraoperativeRecord.findUnique({
        where: { caseId: id },
        select: { updatedAt: true, syncRevision: true },
      })
      return { fresh, removed }
    })

    if (result instanceof Response) return result
    after(() => logAudit(user.id, "CASE_EVENT_DELETE", id, { eventId, removed: result.removed, source }))
    return NextResponse.json({
      ok: true,
      intraopUpdatedAt: result.fresh?.updatedAt,
      intraopRevision: result.fresh?.syncRevision,
    })
  } catch (error: unknown) {
    return eventItemError(error, "DELETE", id)
  }
}
