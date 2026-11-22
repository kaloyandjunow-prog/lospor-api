import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/** Who has a case open (10.8.0): the people in it, counted while their screens keep reporting. */
describe.skipIf(!runPostgres)("case presence", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let presence: typeof import("@/lib/case-presence")
  const suffix = randomUUID()
  const maria = `presence-maria-${suffix}`
  const ivan = `presence-ivan-${suffix}`
  const caseId = `presence-case-${suffix}`

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    presence = await import("@/lib/case-presence")
    for (const [id, name] of [[maria, "Мария Иванова"], [ivan, "Иван Петров"]] as const) {
      await prisma.user.create({ data: { id, email: `${id}@example.test`, name, passwordHash: "not-a-real-password" } })
    }
    await prisma.case.create({ data: { id: caseId, userId: maria, createdById: maria, status: "IN_PROGRESS" } })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { id: caseId } })
    await prisma.user.deleteMany({ where: { id: { in: [maria, ivan] } } })
    await prisma.$disconnect()
  })

  it("lists each person once, however many screens, and marks the reader", async () => {
    const now = new Date()
    await presence.touchCasePresence({ caseId, userId: maria, deviceId: "phone" }, now)
    await presence.touchCasePresence({ caseId, userId: maria, deviceId: "desk" }, now)
    const seen = await presence.touchCasePresence({ caseId, userId: ivan, deviceId: "tablet" }, now)
    expect(seen.screens).toBe(3)
    expect(seen.people.map(person => person.name).sort()).toEqual(["Иван Петров", "Мария Иванова"])
    expect(seen.people.find(person => person.name === "Иван Петров")?.you).toBe(true)
    expect(seen.people.find(person => person.name === "Мария Иванова")?.you).toBe(false)
  })

  it("drops a screen that stopped reporting, and one that left", async () => {
    const later = new Date(Date.now() + 5 * 60_000)
    const alone = await presence.touchCasePresence({ caseId, userId: ivan, deviceId: "tablet" }, later)
    expect(alone.screens).toBe(1)
    await presence.touchCasePresence({ caseId, userId: maria, deviceId: "phone" }, later)
    await presence.leaveCasePresence({ caseId, userId: maria, deviceId: "phone" })
    expect((await presence.readCasePresence(caseId, ivan, later)).screens).toBe(1)
  })
})
