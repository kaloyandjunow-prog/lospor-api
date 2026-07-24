import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

export async function GET() {
  const institutions = await prisma.institution.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, city: true },
  })
  return NextResponse.json(institutions)
}
