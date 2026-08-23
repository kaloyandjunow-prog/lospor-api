import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { corsHeaders } from "@/lib/cors"
import { institutionRequestScope } from "@/lib/institution-requests"

/**
 * The queue of people asking to join a department.
 *
 * An administrator sees every request. A head of department sees only requests
 * to join *their* institution — the ones they are entitled to decide, because
 * approving one is what gives them sight of that clinician's cases.
 */

const CORS = (req: NextRequest) => corsHeaders(req, "GET, OPTIONS")

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  const scope = institutionRequestScope(user)
  if (!scope) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: CORS(req) })

  const requests = await prisma.institutionChangeRequest.findMany({
    where: {
      status: "PENDING",
      ...scope,
      user: {
        activatedAt: { not: null },
        suspendedAt: null,
        recoveryRequiredAt: null,
        deletedAt: null,
        anonymizedAt: null,
      },
    },
    orderBy: { requestedAt: "asc" },
    include: {
      user: { select: { id: true, name: true, email: true, username: true, role: true } },
      requestedInstitution: { select: { id: true, name: true, city: true } },
    },
  })

  return NextResponse.json(requests, { headers: CORS(req) })
}
