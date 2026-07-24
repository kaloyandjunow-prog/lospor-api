import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Fix 6: Support optional pagination via ?skip=0&take=5000 (capped at 5000)
  const url = new URL(req.url)
  const skip = Math.max(0, Number(url.searchParams.get("skip") ?? "0"))
  const takeRaw = Number(url.searchParams.get("take") ?? "5000")
  const take = Number.isFinite(takeRaw) ? Math.min(5000, Math.max(1, takeRaw)) : 5000

  const [account, cases, auditLog] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true, email: true, name: true, firstName: true, lastName: true,
        title: true, role: true, institutionId: true, createdAt: true,
        approvedAt: true, acceptedTermsAt: true, termsVersion: true,
        lastLoginAt: true, deletedAt: true,
        // passwordHash intentionally excluded
      },
    }),
    prisma.case.findMany({
      where:   { userId: user.id },
      include: { preop: true, intraop: true, postop: true },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.auditLog.findMany({
      where:   { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
  ])

  // Fix 5: Reject export requests from soft-deleted accounts
  if (account?.deletedAt) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const exportDate = new Date().toISOString().split("T")[0]
  const payload = {
    exportedAt: new Date().toISOString(),
    exportNote: "This is a copy of all data LOSPOR holds about your account under GDPR Article 15.",
    user: account,
    cases,
    auditLog,
  }

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="lospor-export-${exportDate}.json"`,
    },
  })
}
