import { NextResponse, after } from "next/server"
import { logAudit } from "@/lib/audit"
import { authorizeResearchRequest, researchRouteError } from "@/lib/research/request"
import { readResearchCase } from "@/lib/research/repository"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeResearchRequest(request, "inspectCases")
  if ("response" in auth) return auth.response
  try {
    const { id } = await params
    const item = await readResearchCase(id, auth.context.caseScope)
    if (!item) {
      return NextResponse.json(
        { error: "Research case not found", code: "RESEARCH_CASE_NOT_FOUND" },
        { status: 404 },
      )
    }
    after(() => logAudit(auth.context.user.id, "RESEARCH_CASE_VIEW", id, {
      researchId: item.researchId,
    }))
    return NextResponse.json(item)
  } catch (error) {
    return researchRouteError(error)
  }
}
