import { NextRequest, NextResponse, after } from "next/server"
import { z } from "zod"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import { corsHeaders } from "@/lib/cors"

/**
 * Asking to move to another institution.
 *
 * Choosing an institution at registration is self-service. Moving afterwards is
 * not: institutional membership is what lets a head of department see a
 * clinician's cases, so joining a department needs that department's consent.
 *
 * `PATCH /v1/user` still refuses `institutionId` outright — that is the guard
 * this route exists to give a legitimate path around, rather than weaken.
 */

const CORS = (req: NextRequest) => corsHeaders(req, "GET, POST, OPTIONS")

const bodySchema = z.object({
  institutionId: z.string().cuid(),
})

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS(req) })

  const request = await prisma.institutionChangeRequest.findFirst({
    where:   { userId: user.id },
    orderBy: { requestedAt: "desc" },
    include: { requestedInstitution: { select: { id: true, name: true, city: true } } },
  })

  return NextResponse.json(request ?? null, { headers: CORS(req) })
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS(req) })

  let institutionId: string
  try {
    institutionId = bodySchema.parse(await req.json()).institutionId
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: CORS(req) })
  }

  const me = await prisma.user.findUnique({
    where:  { id: user.id },
    select: { institutionId: true },
  })
  if (!me) return NextResponse.json({ error: "Not found" }, { status: 404, headers: CORS(req) })

  if (me.institutionId === institutionId) {
    return NextResponse.json(
      { error: "You already belong to that institution" },
      { status: 409, headers: CORS(req) },
    )
  }

  const institution = await prisma.institution.findUnique({
    where:  { id: institutionId },
    select: { id: true, name: true, city: true },
  })
  if (!institution) {
    return NextResponse.json({ error: "Unknown institution" }, { status: 404, headers: CORS(req) })
  }

  const pending = await prisma.institutionChangeRequest.findFirst({
    where:  { userId: user.id, status: "PENDING" },
    select: { id: true },
  })
  if (pending) {
    return NextResponse.json({ error: "Request already pending" }, { status: 409, headers: CORS(req) })
  }

  const request = await prisma.institutionChangeRequest.create({
    data: {
      userId: user.id,
      requestedInstitutionId: institution.id,
      // Recorded now rather than derived at approval time: by then the
      // clinician's institution is the new one, and where they came from is
      // exactly what the audit trail needs.
      previousInstitutionId: me.institutionId,
    },
    include: { requestedInstitution: { select: { id: true, name: true, city: true } } },
  })

  after(() => logAudit(user.id, "INSTITUTION_CHANGE_REQUEST_SUBMIT", user.id, {
    requestedInstitutionId: institution.id,
    previousInstitutionId: me.institutionId,
  }))

  return NextResponse.json(request, { status: 201, headers: CORS(req) })
}
