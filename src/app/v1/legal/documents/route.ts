import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { activeLegalDocuments, LegalConfigurationError } from "@/lib/legal-documents"
import { corsHeaders } from "@/lib/cors"

const querySchema = z.enum(["bg", "en"])
const CORS = (request: NextRequest) => corsHeaders(request, "GET, OPTIONS")

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(request) })
}

export async function GET(request: NextRequest) {
  const parsed = querySchema.safeParse(request.nextUrl.searchParams.get("locale"))
  if (!parsed.success) {
    return NextResponse.json(
      { error: "locale must be bg or en", code: "INVALID_LOCALE" },
      { status: 400, headers: CORS(request) },
    )
  }
  try {
    return NextResponse.json(
      { locale: parsed.data, documents: activeLegalDocuments(parsed.data) },
      { headers: CORS(request) },
    )
  } catch (error) {
    if (error instanceof LegalConfigurationError) {
      return NextResponse.json(
        { error: "Legal documents are not configured", code: error.code },
        { status: error.status, headers: CORS(request) },
      )
    }
    throw error
  }
}
