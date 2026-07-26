import { NextResponse } from "next/server"

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "lospor-api",
    version: process.env.npm_package_version ?? "7.1.0",
  })
}
