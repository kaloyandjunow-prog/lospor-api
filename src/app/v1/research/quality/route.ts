import { NextResponse } from "next/server"
import { authorizeResearchRequest, researchRouteError } from "@/lib/research/request"
import { researchDataSource } from "@/lib/research/source"

export async function GET(request: Request) {
  const auth = await authorizeResearchRequest(request)
  if ("response" in auth) return auth.response
  try {
    return NextResponse.json(await researchDataSource().quality(auth.context))
  } catch (error) {
    return researchRouteError(error)
  }
}
