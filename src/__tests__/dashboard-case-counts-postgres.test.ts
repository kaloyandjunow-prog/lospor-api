import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * The dashboard's "today" and "this month" tiles, counted by the database
 * (9.13.8). They used to load every accessible case and filter in JavaScript;
 * the query has to give the same answer, which only a real database can show.
 */
describe.skipIf(!runPostgres)("dashboard counts in PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let dashboardCaseCounts: typeof import("@/lib/dashboard-case-counts").dashboardCaseCounts
  const userId = `dash-user-${randomUUID()}`
  // 13:00 in Sofia on 7 September 2026 (UTC+3).
  const NOW = new Date("2026-09-07T10:00:00.000Z")

  const cases: { createdAt: string; monthYear?: string | null }[] = [
    // Today in Sofia: 00:30 local is still 6 September in UTC.
    { createdAt: "2026-09-06T21:30:00.000Z" },
    // Yesterday in Sofia, though the same UTC date as the one above.
    { createdAt: "2026-09-06T20:30:00.000Z" },
    // Earlier this month, no intraop record: counted by creation date.
    { createdAt: "2026-09-02T09:00:00.000Z" },
    // Created last month but labelled this month, in both spellings.
    { createdAt: "2026-08-20T09:00:00.000Z", monthYear: "2026-09" },
    { createdAt: "2026-08-21T09:00:00.000Z", monthYear: "2026-9" },
    // Created this month but labelled last month: the label wins.
    { createdAt: "2026-09-03T09:00:00.000Z", monthYear: "2026-08" },
    // An intraop record with no label, and with an empty one: creation date.
    { createdAt: "2026-09-04T09:00:00.000Z", monthYear: null },
    { createdAt: "2026-09-05T09:00:00.000Z", monthYear: "" },
    // 00:30 on 1 October in Sofia is 30 September in UTC: next month.
    { createdAt: "2026-09-30T21:30:00.000Z" },
  ]

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ dashboardCaseCounts } = await import("@/lib/dashboard-case-counts"))
    await prisma.user.create({
      // A username as well as an email: the Hospital database requires one.
      data: { id: userId, email: `${userId}@example.test`, username: userId, usernameCanonical: userId.toLowerCase(), name: "Dashboard counts", passwordHash: "x" },
    })
    for (const [i, c] of cases.entries()) {
      await prisma.case.create({
        data: {
          id: `${userId}-case-${i}`, userId, createdById: userId, createdAt: new Date(c.createdAt),
          ...(c.monthYear !== undefined ? { intraop: { create: { monthYear: c.monthYear } } } : {}),
        },
      })
    }
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
  })

  it("counts today by the Sofia calendar day", async () => {
    const counts = await dashboardCaseCounts({ userId }, userId, NOW)
    expect(counts.all).toBe(cases.length)
    expect(counts.today).toBe(1)
  })

  it("counts this month by the label when there is one, else by the Sofia creation date", async () => {
    const counts = await dashboardCaseCounts({ userId }, userId, NOW)
    // Today, yesterday (still September), 2 September, the two labelled
    // September, the unlabelled and the empty-labelled records. Not the one
    // labelled August, and not 1 October.
    expect(counts.month).toBe(7)
  })
})
