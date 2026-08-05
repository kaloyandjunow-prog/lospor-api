import { NextRequest, NextResponse, after } from "next/server"
import { z } from "zod"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import { corsHeaders } from "@/lib/cors"
import { institutionRequestScope } from "@/lib/institution-requests"

/**
 * Resolving a request to change institution.
 *
 * Approving is the moment a clinician joins a department and its head gains
 * sight of their cases, so the scope check keys on the institution being
 * *joined* — see institutionRequestScope.
 *
 * This is the only path that writes User.institutionId. The self-service
 * endpoint refuses the field, and until now nothing else wrote it either, so a
 * move meant editing the database by hand.
 */

const CORS = (req: NextRequest) => corsHeaders(req, "POST, OPTIONS")

const bodySchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
})

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  const scope = institutionRequestScope(user)
  if (!scope || !user?.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: CORS(req) })
  }

  const { id } = await params

  let decision: "APPROVE" | "REJECT"
  try {
    decision = bodySchema.parse(await req.json()).decision
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: CORS(req) })
  }

  try {
    const result = await prisma.$transaction(async tx => {
      // The scope is part of the lookup, not a check afterwards: a head of
      // department asking for a request outside their institution gets the same
      // 404 as one that does not exist, and learns nothing either way.
      const request = await tx.institutionChangeRequest.findFirst({
        where: { id, ...scope },
        select: {
          id: true,
          userId: true,
          status: true,
          requestedInstitutionId: true,
          previousInstitutionId: true,
        },
      })
      if (!request) return { notFound: true as const }
      if (request.status !== "PENDING") return { alreadyResolved: true as const }

      const resolvedAt = new Date()
      await tx.institutionChangeRequest.update({
        where: { id: request.id },
        data: {
          status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
          resolvedAt,
          resolvedById: user.id,
        },
      })

      if (decision === "APPROVE") {
        await tx.user.update({
          where: { id: request.userId },
          data:  { institutionId: request.requestedInstitutionId },
        })
      }

      return { request, resolvedAt }
    })

    if ("notFound" in result) {
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: CORS(req) })
    }
    if ("alreadyResolved" in result) {
      return NextResponse.json(
        { error: "This request has already been resolved" },
        { status: 409, headers: CORS(req) },
      )
    }

    after(() => logAudit(
      user.id,
      decision === "APPROVE" ? "INSTITUTION_CHANGE_APPROVE" : "INSTITUTION_CHANGE_REJECT",
      result.request.userId,
      {
        requestId: result.request.id,
        requestedInstitutionId: result.request.requestedInstitutionId,
        previousInstitutionId: result.request.previousInstitutionId,
      },
    ))

    return NextResponse.json({
      id: result.request.id,
      status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
      resolvedAt: result.resolvedAt,
    }, { headers: CORS(req) })
  } catch (error) {
    console.error("[POST /v1/admin/institution-requests/[id]]", error)
    return NextResponse.json(
      { error: "Failed to resolve the request. Nothing was changed." },
      { status: 500, headers: CORS(req) },
    )
  }
}
