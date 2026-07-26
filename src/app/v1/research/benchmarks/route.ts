import { NextResponse, after } from "next/server"
import { logAudit } from "@/lib/audit"
import { authorizeResearchRequest, researchRouteError } from "@/lib/research/request"
import { researchBenchmarkSchema } from "@/lib/research/schemas"
import { researchDataSource } from "@/lib/research/source"

export async function POST(request: Request) {
  const auth = await authorizeResearchRequest(request, "benchmark")
  if ("response" in auth) return auth.response
  try {
    const parsed = researchBenchmarkSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid benchmark request", code: "INVALID_RESEARCH_BENCHMARK", details: parsed.error.flatten() },
        { status: 400 },
      )
    }
    const result = await researchDataSource().benchmark(parsed.data, auth.context)
    after(() => logAudit(auth.context.user.id, "RESEARCH_BENCHMARK", parsed.data.metric, {
      interval: parsed.data.interval,
      pointCount: result.points.length,
    }))
    return NextResponse.json(result)
  } catch (error) {
    return researchRouteError(error)
  }
}
