import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { logAuditInTransaction } from "@/lib/audit"
import { authorizeResearchRequest, researchRouteError } from "@/lib/research/request"
import { researchGrantCreateSchema } from "@/lib/research/schemas"
import { researchGrantExpiry } from "@/lib/research/grant-policy"

export async function GET(request: Request) {
  const auth = await authorizeResearchRequest(request, "manageAccess")
  if ("response" in auth) return auth.response
  try {
    const grants = await prisma.researchAccessGrant.findMany({
      include: {
        user: { select: { id: true, name: true, email: true, username: true, role: true, accountKind: true } },
        institution: { select: { id: true, name: true } },
        grantedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    })
    return NextResponse.json(grants)
  } catch (error) {
    return researchRouteError(error)
  }
}

export async function POST(request: Request) {
  const auth = await authorizeResearchRequest(request, "manageAccess")
  if ("response" in auth) return auth.response
  try {
    const parsed = researchGrantCreateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid research grant", code: "INVALID_RESEARCH_GRANT", details: parsed.error.flatten() },
        { status: 400 },
      )
    }
    const target = await prisma.user.findUnique({
      where: { id: parsed.data.userId },
      select: {
        id: true,
        role: true,
        accountKind: true,
        activatedAt: true,
        suspendedAt: true,
        recoveryRequiredAt: true,
        deletedAt: true,
        anonymizedAt: true,
      },
    })
    if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 })
    if (
      !target.activatedAt
      || target.suspendedAt
      || target.recoveryRequiredAt
      || target.deletedAt
      || target.anonymizedAt
    ) {
      return NextResponse.json(
        { error: "Research access cannot be granted to an inactive account", code: "RESEARCH_ACCOUNT_INACTIVE" },
        { status: 422 },
      )
    }
    const expiresAt = researchGrantExpiry(parsed.data.expiresAt)
    // The grant and the record of who issued it commit together. Granting
    // someone access to the register is exactly the kind of act whose audit
    // entry must not be able to go missing on its own.
    const grant = await prisma.$transaction(async tx => {
      const created = await tx.researchAccessGrant.create({
        data: {
          userId: parsed.data.userId,
          institutionId: parsed.data.allInstitutions
            ? null
            : parsed.data.institutionId ?? null,
          allInstitutions: parsed.data.allInstitutions,
          canQuery: parsed.data.canQuery,
          canInspectCases: parsed.data.canInspectCases,
          canExport: parsed.data.canExport,
          canExportOmop: parsed.data.canExportOmop,
          canShareCohorts: parsed.data.canShareCohorts,
          expiresAt,
          grantedById: auth.context.user.id,
        },
        include: {
          user: { select: { id: true, name: true, email: true, username: true, role: true, accountKind: true } },
          institution: { select: { id: true, name: true } },
        },
      })
      await logAuditInTransaction(tx, auth.context.user.id, "RESEARCH_GRANT_CREATE", created.id, {
        targetUserId: created.userId,
        institutionId: created.institutionId,
        allInstitutions: created.allInstitutions,
        canQuery: created.canQuery,
        canInspectCases: created.canInspectCases,
        canExport: created.canExport,
        canExportOmop: created.canExportOmop,
        canShareCohorts: created.canShareCohorts,
        expiresAt: created.expiresAt.toISOString(),
      })
      return created
    })
    return NextResponse.json(grant, { status: 201 })
  } catch (error) {
    return researchRouteError(error)
  }
}
