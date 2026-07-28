import { NextResponse } from "next/server"
import { API_RELEASE_VERSION } from "@/lib/api-version"

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "lospor-api",
    version: API_RELEASE_VERSION,
  })
}
