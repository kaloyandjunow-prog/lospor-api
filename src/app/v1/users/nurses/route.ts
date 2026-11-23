import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"

/** The anaesthesia nurses of the caller's department, for the pickers (10.8.0). */
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  // No institution, no department: nobody to list (an empty filter would list every hospital's nurses).
  if (user.role !== "ADMIN" && !user.institutionId) return NextResponse.json({ nurses: [] }, { headers: corsHeaders(req) })
  const nurses = await prisma.user.findMany({
    where: {
      role: "ANAESTHESIA_NURSE",
      activatedAt: { not: null },
      suspendedAt: null,
      deletedAt: null,
      anonymizedAt: null,
      ...(user.role === "ADMIN" || !user.institutionId ? {} : { institutionId: user.institutionId }),
    },
    select: { id: true, name: true, firstName: true, lastName: true, title: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  })
  return NextResponse.json({ nurses }, { headers: corsHeaders(req) })
}
