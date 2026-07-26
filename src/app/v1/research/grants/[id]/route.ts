import { NextResponse, after } from "next/server"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import { authorizeResearchRequest, researchRouteError } from "@/lib/research/request"
import { researchGrantPatchSchema } from "@/lib/research/schemas"

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeResearchRequest(request, "manageAccess")
  if ("response" in auth) return auth.response
  try {
    const { id } = await params
    const parsed = researchGrantPatchSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid research grant", code: "INVALID_RESEARCH_GRANT", details: parsed.error.flatten() },
        { status: 400 },
      )
    }
    const existing = await prisma.researchAccessGrant.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: "Grant not found" }, { status: 404 })
    const grant = await prisma.researchAccessGrant.update({
      where: { id },
      data: {
        ...(parsed.data.canInspectCases !== undefined
          ? { canInspectCases: parsed.data.canInspectCases }
          : {}),
        ...(parsed.data.canExport !== undefined ? { canExport: parsed.data.canExport } : {}),
        ...(parsed.data.canExportOmop !== undefined
          ? { canExportOmop: parsed.data.canExportOmop }
          : {}),
        ...(parsed.data.expiresAt !== undefined
          ? { expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null }
          : {}),
        ...(parsed.data.revoked !== undefined
          ? { revokedAt: parsed.data.revoked ? new Date() : null }
          : {}),
      },
    })
    after(() => logAudit(auth.context.user.id, "RESEARCH_GRANT_UPDATE", id, {
      targetUserId: grant.userId,
      revoked: !!grant.revokedAt,
    }))
    return NextResponse.json(grant)
  } catch (error) {
    return researchRouteError(error)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeResearchRequest(request, "manageAccess")
  if ("response" in auth) return auth.response
  try {
    const { id } = await params
    const existing = await prisma.researchAccessGrant.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: "Grant not found" }, { status: 404 })
    const grant = await prisma.researchAccessGrant.update({
      where: { id },
      data: { revokedAt: new Date() },
    })
    after(() => logAudit(auth.context.user.id, "RESEARCH_GRANT_REVOKE", id, {
      targetUserId: grant.userId,
    }))
    return NextResponse.json({ ok: true })
  } catch (error) {
    return researchRouteError(error)
  }
}
