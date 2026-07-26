import { NextResponse, after } from "next/server"
import { activeResearchFilterCount } from "@lospor/core/research"
import { logAudit } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { authorizeResearchRequest, researchRouteError } from "@/lib/research/request"
import { researchQuerySchema } from "@/lib/research/schemas"
import { researchDataSource } from "@/lib/research/source"

export async function POST(request: Request) {
  const auth = await authorizeResearchRequest(request)
  if ("response" in auth) return auth.response
  try {
    const parsed = researchQuerySchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid research query", code: "INVALID_RESEARCH_QUERY", details: parsed.error.flatten() },
        { status: 400 },
      )
    }
    const result = await researchDataSource().query(parsed.data, auth.context)
    if (parsed.data.savedCohortId) {
      await prisma.researchCohort.updateMany({
        where: { id: parsed.data.savedCohortId, ownerId: auth.context.user.id },
        data: { lastRunAt: new Date() },
      })
    }
    after(() => logAudit(auth.context.user.id, "RESEARCH_QUERY", "cohort", {
      filterCount: activeResearchFilterCount(parsed.data.cohort),
      matchingCases: result.matchingCases,
      returnedCases: result.cases.length,
    }))
    return NextResponse.json(result)
  } catch (error) {
    return researchRouteError(error)
  }
}
