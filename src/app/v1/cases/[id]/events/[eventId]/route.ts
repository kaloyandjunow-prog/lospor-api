import { NextRequest, NextResponse, after } from "next/server"
import { z } from "zod"

import { canAccessCase } from "@/lib/access-control"
import { logAudit } from "@/lib/audit"
import { addEvent, deleteEvent, rebuildProjection, reserveIntraopRevision, type LogEvent } from "@/lib/case-events"
import { checkEventPII, piiErrorBody } from "@/lib/clinical-pii"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"

const CORS = (req: NextRequest) => corsHeaders(req, "PUT, DELETE, OPTIONS")

const eventSchema = z.object({
  ts: z.string().optional(),
  type: z.string().min(1).max(64),
  name: z.string().max(200).optional(),
  label: z.string().max(200).optional(),
  dose: z.union([z.string(), z.number()]).optional(),
  unit: z.string().max(40).optional(),
  rate: z.union([z.string(), z.number()]).optional(),
  volume: z.union([z.string(), z.number()]).optional(),
}).passthrough()

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

async function authorize(req: NextRequest, caseId: string) {
  const user = await getAuthUser(req)
  if (!user?.id) return { error: "Unauthorized", status: 401 as const }
  const existing = await prisma.case.findUnique({
    where: { id: caseId },
    select: {
      userId: true,
      status: true,
      user: { select: { institutionId: true } },
      intraop: { select: { updatedAt: true, syncRevision: true } },
    },
  })
  if (!existing) return { error: "Not found", status: 404 as const }
  if (!canAccessCase(user, existing)) return { error: "Forbidden", status: 403 as const }
  if (existing.status === "COMPLETE") return { error: "Case is finalised", status: 403 as const }
  return { user, existing }
}

function conflict(existing: { intraop: { updatedAt: Date; syncRevision: number } | null }, revision: number | null) {
  if (revision == null || !existing.intraop || existing.intraop.syncRevision === revision) return null
  return NextResponse.json({
    error: "conflict",
    section: "intraop",
    serverVersion: {
      updatedAt: existing.intraop.updatedAt,
      revision: existing.intraop.syncRevision,
    },
  }, { status: 409 })
}

function sourceFrom(req: NextRequest): string {
  const source = req.headers.get("x-lospor-source")
  if (source === "web" || source === "mobile" || source === "ai" || source === "import") return source
  return req.headers.get("authorization")?.startsWith("Bearer ") ? "mobile" : "web"
}

async function freshRevision(caseId: string) {
  return prisma.intraoperativeRecord.findUnique({
    where: { caseId },
    select: { updatedAt: true, syncRevision: true },
  })
}

async function reserveRevision(caseId: string, revision: number | null, hasIntraop: boolean) {
  if (revision == null || !hasIntraop) return { reserved: false as const }
  if (await reserveIntraopRevision(prisma, caseId, revision)) return { reserved: true as const }
  const fresh = await freshRevision(caseId)
  return {
    response: NextResponse.json({
      error: "conflict",
      section: "intraop",
      serverVersion: fresh ? { updatedAt: fresh.updatedAt, revision: fresh.syncRevision } : undefined,
    }, { status: 409 }),
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  const { id, eventId } = await params
  const auth = await authorize(req, id)
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const revision = revisionFrom(req)
  if (revision === "invalid") return NextResponse.json({ error: "Invalid intraop revision" }, { status: 400 })
  const stale = conflict(auth.existing, revision)
  if (stale) return stale

  let parsed: z.infer<typeof eventSchema>
  try {
    parsed = eventSchema.parse(await req.json())
  } catch {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 })
  }
  const event = { ...parsed, id: eventId }
  const piiError = checkEventPII(event)
  if (piiError) return NextResponse.json(piiErrorBody(piiError), { status: 400 })

  const reservation = await reserveRevision(id, revision, !!auth.existing.intraop)
  if ("response" in reservation) return reservation.response
  await addEvent(prisma, id, auth.user.id, event as LogEvent, sourceFrom(req))
  await rebuildProjection(prisma, id, { revisionAlreadyReserved: reservation.reserved })
  after(() => logAudit(auth.user.id, "CASE_EVENT_EDIT", id, { eventId }))
  const fresh = await freshRevision(id)
  return NextResponse.json({
    ok: true,
    intraopUpdatedAt: fresh?.updatedAt,
    intraopRevision: fresh?.syncRevision,
  })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  const { id, eventId } = await params
  const auth = await authorize(req, id)
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const revision = revisionFrom(req)
  if (revision === "invalid") return NextResponse.json({ error: "Invalid intraop revision" }, { status: 400 })
  const stale = conflict(auth.existing, revision)
  if (stale) return stale

  const reservation = await reserveRevision(id, revision, !!auth.existing.intraop)
  if ("response" in reservation) return reservation.response
  const removed = await deleteEvent(prisma, id, eventId)
  if (removed) await rebuildProjection(prisma, id, { revisionAlreadyReserved: reservation.reserved })
  after(() => logAudit(auth.user.id, "CASE_EVENT_DELETE", id, { eventId }))
  const fresh = await freshRevision(id)
  return NextResponse.json({
    ok: true,
    intraopUpdatedAt: fresh?.updatedAt,
    intraopRevision: fresh?.syncRevision,
  })
}
