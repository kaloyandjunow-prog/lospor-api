import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`
    return NextResponse.json({ status: "ready", database: "ok" })
  } catch {
    return NextResponse.json(
      { status: "unavailable", database: "error" },
      { status: 503 },
    )
  }
}
