import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { syncCaseRelational } from "@/lib/relational-sync"

// Repair tool, not a read-only check: re-derives relational rows from the
// authoritative JSON (delete + recreate, in a transaction) for all cases (or
// a single case if ?caseId=... is provided). Renamed from
// "validate-relational" — the old name implied this only inspects for drift,
// but it actively rewrites the relational mirror every time it runs.
// ADMIN-only.

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!requireRole(user, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const caseId = req.nextUrl.searchParams.get("caseId")

  // Repairing every case in one request re-derives the whole relational mirror
  // serially and will exceed the function timeout once the register is more
  // than a few hundred cases — leaving the caller with a 504 and no idea how
  // far it got. Work through it a page at a time instead: each call reports the
  // cursor to resume from, so an admin (or a script) can drive it to completion.
  const takeRaw = Number(req.nextUrl.searchParams.get("batch") ?? "50")
  const batch = Number.isFinite(takeRaw) ? Math.min(200, Math.max(1, takeRaw)) : 50
  const cursor = req.nextUrl.searchParams.get("cursor")

  const cases = caseId
    ? await prisma.case.findMany({ where: { id: caseId }, select: { id: true } })
    : await prisma.case.findMany({
        select:  { id: true },
        orderBy: { id: "asc" },
        take:    batch,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })

  const report: { caseId: string; status: "ok" | "repaired" | "error"; error?: string }[] = []

  for (const c of cases) {
    try {
      await syncCaseRelational(prisma, c.id)
      report.push({ caseId: c.id, status: "repaired" })
    } catch (err: unknown) {
      report.push({ caseId: c.id, status: "error", error: String(err instanceof Error ? err.message : err) })
    }
  }

  const errorCount    = report.filter(r => r.status === "error").length
  const repairedCount = report.filter(r => r.status === "repaired").length
  // Present only when there is more to do, so a caller can loop until it is absent.
  const nextCursor = !caseId && cases.length === batch ? cases[cases.length - 1].id : null

  return NextResponse.json({
    total: cases.length, repaired: repairedCount, errors: errorCount, report,
    ...(nextCursor ? { nextCursor } : {}),
  })
}
