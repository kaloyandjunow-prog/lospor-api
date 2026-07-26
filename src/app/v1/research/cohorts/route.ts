import { NextResponse, after } from "next/server"
import { z } from "zod"
import type { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import { authorizeResearchRequest, researchRouteError } from "@/lib/research/request"
import { savedCohortCreateSchema } from "@/lib/research/schemas"

const createSchema = savedCohortCreateSchema.extend({
  institutionId: z.string().trim().min(1).nullable().optional(),
})

function serialize(record: Awaited<ReturnType<typeof prisma.researchCohort.create>>) {
  return {
    ...record,
    definition: record.definition,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    lastRunAt: record.lastRunAt?.toISOString() ?? null,
  }
}

export async function GET(request: Request) {
  const auth = await authorizeResearchRequest(request)
  if ("response" in auth) return auth.response
  try {
    const sharedScope = auth.context.scopeKind === "ALL"
      ? { visibility: "INSTITUTION" as const }
      : {
          visibility: "INSTITUTION" as const,
          institutionId: { in: auth.context.institutionIds },
        }
    const rows = await prisma.researchCohort.findMany({
      where: {
        OR: [
          { ownerId: auth.context.user.id },
          sharedScope,
        ],
      },
      orderBy: { updatedAt: "desc" },
    })
    return NextResponse.json(rows.map(serialize))
  } catch (error) {
    return researchRouteError(error)
  }
}

export async function POST(request: Request) {
  const auth = await authorizeResearchRequest(request, "savePrivateCohorts")
  if ("response" in auth) return auth.response
  try {
    const parsed = createSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid saved cohort", code: "INVALID_SAVED_COHORT", details: parsed.error.flatten() },
        { status: 400 },
      )
    }
    const institutionId = parsed.data.institutionId
      ?? (auth.context.institutionIds.length === 1 ? auth.context.institutionIds[0] : null)
    if (parsed.data.visibility === "INSTITUTION") {
      if (!auth.context.permissions.shareInstitutionCohorts || !institutionId) {
        return NextResponse.json(
          { error: "Institution cohort sharing is not permitted", code: "COHORT_SHARE_FORBIDDEN" },
          { status: 403 },
        )
      }
      if (auth.context.scopeKind !== "ALL" && !auth.context.institutionIds.includes(institutionId)) {
        return NextResponse.json(
          { error: "Institution is outside your research scope", code: "INSTITUTION_SCOPE_FORBIDDEN" },
          { status: 403 },
        )
      }
    }
    const row = await prisma.researchCohort.create({
      data: {
        ownerId: auth.context.user.id,
        institutionId: parsed.data.visibility === "INSTITUTION" ? institutionId : null,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        visibility: parsed.data.visibility,
        definition: parsed.data.definition as unknown as Prisma.InputJsonValue,
      },
    })
    after(() => logAudit(auth.context.user.id, "RESEARCH_COHORT_CREATE", row.id, {
      visibility: row.visibility,
    }))
    return NextResponse.json(serialize(row), { status: 201 })
  } catch (error) {
    return researchRouteError(error)
  }
}
