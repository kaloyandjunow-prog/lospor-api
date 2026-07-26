import { NextResponse, after } from "next/server"
import { activeResearchFilterCount } from "@lospor/core/research"
import { logAudit } from "@/lib/audit"
import { authorizeResearchRequest, researchRouteError } from "@/lib/research/request"
import { researchComparisonSchema } from "@/lib/research/schemas"
import { researchDataSource } from "@/lib/research/source"

export async function POST(request: Request) {
  const auth = await authorizeResearchRequest(request, "compare")
  if ("response" in auth) return auth.response
  try {
    const parsed = researchComparisonSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid cohort comparison", code: "INVALID_RESEARCH_COMPARISON", details: parsed.error.flatten() },
        { status: 400 },
      )
    }
    const result = await researchDataSource().compare(parsed.data, auth.context)
    after(() => logAudit(auth.context.user.id, "RESEARCH_COMPARE", "cohorts", {
      leftFilters: activeResearchFilterCount(parsed.data.left),
      rightFilters: activeResearchFilterCount(parsed.data.right),
      leftCount: result.leftCount,
      rightCount: result.rightCount,
    }))
    return NextResponse.json(result)
  } catch (error) {
    return researchRouteError(error)
  }
}
