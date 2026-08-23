import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { POST as recordLegalAcceptances } from "@/app/v1/user/legal-acceptances/route"

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function PATCH(req: NextRequest) {
  // Compatibility verb for first-party clients released before the canonical
  // /v1/user/legal-acceptances endpoint. It intentionally requires the same
  // exact TERMS + PRIVACY descriptors; the old empty-body timestamp shortcut
  // is not retained because it could not prove what was accepted.
  return recordLegalAcceptances(req)
}
