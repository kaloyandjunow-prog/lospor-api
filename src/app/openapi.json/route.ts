import { NextResponse } from "next/server"
import document from "@/generated/openapi.json"

export function GET() {
  return NextResponse.json(document, {
    headers: { "Cache-Control": "public, max-age=300" },
  })
}
