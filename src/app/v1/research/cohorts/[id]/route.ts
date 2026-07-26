import { NextResponse, after } from "next/server"
import type { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
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
    if (
      parsed.data.visibility === "INSTITUTION" &&
      !auth.context.permissions.shareInstitutionCohorts
    ) {
      return NextResponse.json({ error: "Cohort sharing is not permitted" }, { status: 403 })
    }
    const row = await prisma.researchCohort.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility } : {}),
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
