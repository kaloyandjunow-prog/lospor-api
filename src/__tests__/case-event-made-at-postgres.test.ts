import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

// The last change made wins across devices (9.13.0), not the last to arrive.

describe.skipIf(!runPostgres)("event changes: the last one made wins", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let events: typeof import("@/lib/case-events")
  const userId = `made-at-user-${randomUUID()}`
  const caseId = `made-at-case-${randomUUID()}`
  const at = (minutes: number) => new Date(Date.parse("2026-09-27T12:00:00.000Z") + minutes * 60_000)
  const stop = (extra: Record<string, unknown> = {}) => ({ id: "stop", ts: at(40).toISOString(), type: "infusion_stop", infId: "i", ...extra })

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    events = await import("@/lib/case-events")
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, name: "Made-at test", passwordHash: "not-a-real-password" } })
    await prisma.case.create({ data: { id: caseId, userId, createdById: userId } })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.caseEvent.deleteMany({ where: { caseId } })
    await prisma.case.deleteMany({ where: { id: caseId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
  })

  it("an edit made before the latest one is refused; a later one applies", async () => {
    await prisma.$transaction(async tx => {
      await events.addEvent(tx, caseId, userId, stop() as never, "web", at(10))
      // The web moved the stop at 12:20; the phone's edit from 12:15 arrives after.
      await events.addEvent(tx, caseId, userId, stop({ ts: at(45).toISOString() }) as never, "web", at(20))
      expect(await events.laterChangeMade(tx, caseId, "stop", at(15))).toBe(true)
      expect(await events.laterChangeMade(tx, caseId, "stop", at(25))).toBe(false)
    })
  })

  it("an edit made before a deletion cannot bring the entry back", async () => {
    await prisma.$transaction(async tx => {
      await events.deleteEvent(tx, caseId, "stop", at(30))
      expect(await events.laterChangeMade(tx, caseId, "stop", at(28))).toBe(true)
      expect(await events.laterChangeMade(tx, caseId, "stop", at(31))).toBe(false)
    })
  })

  it("rows from before 9.13.0 carry no time and never refuse", async () => {
    await prisma.$transaction(async tx => {
      await tx.caseEvent.create({ data: { ...events.buildRow(caseId, userId, { id: "legacy", ts: at(1).toISOString(), type: "drug", name: "Ondansetron", dose: "4", unit: "mg" } as never, 1, "active", `${caseId}:legacy`, "web") } })
      expect(await events.laterChangeMade(tx, caseId, "legacy", at(0))).toBe(false)
    })
  })
})

describe("when a change was made", () => {
  it("is read from the device's header, never later than just past now", async () => {
    const { madeAtFrom } = await import("@/lib/case-events")
    const now = new Date("2026-09-27T12:00:00.000Z")
    expect(madeAtFrom("2026-09-27T11:55:00.000Z", now).toISOString()).toBe("2026-09-27T11:55:00.000Z")
    expect(madeAtFrom("2026-09-27T13:00:00.000Z", now).toISOString()).toBe("2026-09-27T12:02:00.000Z")
    expect(madeAtFrom(null, now)).toBe(now)
    expect(madeAtFrom("not a time", now)).toBe(now)
  })
})
