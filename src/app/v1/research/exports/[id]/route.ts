import { NextResponse } from "next/server"
import { authorizeResearchRequest, researchRouteError } from "@/lib/research/request"
import { getResearchExport, ResearchExportError } from "@/lib/research/exports"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeResearchRequest(request, "export")
  if ("response" in auth) return auth.response
  try {
    const { id } = await params
    return NextResponse.json(await getResearchExport(auth.context, id))
  } catch (error) {
    if (error instanceof ResearchExportError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      )
    }
    return researchRouteError(error)
  }
}

export const dynamic = "force-dynamic"
