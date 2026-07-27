import { NextResponse, after } from "next/server"
import type { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import { canUseInstitution } from "@/lib/research/access"
import { authorizeResearchRequest, researchRouteError } from "@/lib/research/request"
import { savedCohortPatchSchema } from "@/lib/research/schemas"

async function owned(id: string, ownerId: string) {
  return prisma.researchCohort.findFirst({ where: { id, ownerId } })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeResearchRequest(request)
  if ("response" in auth) return auth.response
  try {
    const { id } = await params
    const row = await prisma.researchCohort.findFirst({
      where: {
        id,
        OR: [
          { ownerId: auth.context.user.id },
          {
            visibility: "INSTITUTION",
            ...(auth.context.scopeKind === "ALL"
              ? {}
              : { institutionId: { in: auth.context.institutionIds } }),
          },
        ],
      },
    })
    if (!row) return NextResponse.json({ error: "Cohort not found" }, { status: 404 })
    return NextResponse.json(row)
  } catch (error) {
    return researchRouteError(error)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeResearchRequest(request, "savePrivateCohorts")
  if ("response" in auth) return auth.response
  try {
    const { id } = await params
    const current = await owned(id, auth.context.user.id)
    if (!current) return NextResponse.json({ error: "Cohort not found" }, { status: 404 })
    const parsed = savedCohortPatchSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid saved cohort", code: "INVALID_SAVED_COHORT", details: parsed.error.flatten() },
        { status: 400 },
      )
    }
    const visibility = parsed.data.visibility ?? current.visibility
    const institutionId = visibility === "INSTITUTION"
      ? parsed.data.institutionId
        ?? current.institutionId
        ?? (auth.context.institutionIds.length === 1 ? auth.context.institutionIds[0] : null)
      : null
    if (visibility === "INSTITUTION") {
      if (!auth.context.permissions.shareInstitutionCohorts || !institutionId) {
        return NextResponse.json(
          { error: "Institution cohort sharing is not permitted", code: "COHORT_SHARE_FORBIDDEN" },
          { status: 403 },
        )
      }
      if (!canUseInstitution(auth.context, institutionId, "query")) {
        return NextResponse.json(
          { error: "Institution is outside your research scope", code: "INSTITUTION_SCOPE_FORBIDDEN" },
          { status: 403 },
        )
      }
    }
    const row = await prisma.researchCohort.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.visibility !== undefined ? { visibility } : {}),
        ...(parsed.data.visibility !== undefined || parsed.data.institutionId !== undefined ? { institutionId } : {}),
        ...(parsed.data.definition !== undefined
          ? { definition: parsed.data.definition as unknown as Prisma.InputJsonValue }
          : {}),
      },
    })
    after(() => logAudit(auth.context.user.id, "RESEARCH_COHORT_UPDATE", id))
    return NextResponse.json(row)
  } catch (error) {
    return researchRouteError(error)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeResearchRequest(request, "savePrivateCohorts")
  if ("response" in auth) return auth.response
  try {
    const { id } = await params
    const current = await owned(id, auth.context.user.id)
    if (!current) return NextResponse.json({ error: "Cohort not found" }, { status: 404 })
    await prisma.researchCohort.delete({ where: { id } })
    after(() => logAudit(auth.context.user.id, "RESEARCH_COHORT_DELETE", id))
    return NextResponse.json({ ok: true })
  } catch (error) {
    return researchRouteError(error)
  }
}
