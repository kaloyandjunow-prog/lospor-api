import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

const { afterMock, getAuthUserMock } = vi.hoisted(() => ({
  afterMock: vi.fn(),
  getAuthUserMock: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("next/server", async importOriginal => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: afterMock }
})
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * The reading counts behind the vitals questions (10.1.0), on the real
 * database: per band and sign, MAP calculated, auto-filled copies and deleted
 * readings left out, and the month-by-month growth Status draws.
 */
describe.skipIf(!runPostgres)("intraoperative automation, PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let lib: typeof import("@/lib/intraop-automation")
  let addEvent: typeof import("@/lib/case-events").addEvent
  let deleteEvent: typeof import("@/lib/case-events").deleteEvent
  let withLockedCaseTransaction: typeof import("@/lib/clinical-transaction").withLockedCaseTransaction
  let disconnectClinicalPrismaForTests: typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests
  let route: typeof import("@/app/v1/intraop/automation/route")

  const suffix = randomUUID()
  const institutionId = `automation-inst-${suffix}`
  const userId = `automation-user-${suffix}`
  const adultCase = `automation-adult-${suffix}`
  const childCase = `automation-child-${suffix}`
  const scope = { institutionId }

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    lib = await import("@/lib/intraop-automation")
    ;({ addEvent, deleteEvent } = await import("@/lib/case-events"))
    ;({ withLockedCaseTransaction, disconnectClinicalPrismaForTests } = await import("@/lib/clinical-transaction"))
    route = await import("@/app/v1/intraop/automation/route")
    getAuthUserMock.mockResolvedValue({
      id: userId, role: "MEMBER", institutionId, institutionName: null,
      firstName: null, lastName: null, title: null, jti: null,
    })
    await prisma.institution.create({ data: { id: institutionId, name: `Automation ${suffix}`, city: "Sofia" } })
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, username: userId, usernameCanonical: userId.toLowerCase(), name: "Automation test", passwordHash: "not-a-real-password", institutionId } })
    for (const [id, ageYears, startedAt] of [[adultCase, 40, "2026-09-10T08:00:00.000Z"], [childCase, 4, "2026-10-10T08:00:00.000Z"]] as const) {
      await prisma.case.create({ data: { id, userId, createdById: userId, institutionId, status: "IN_PROGRESS" } })
      await prisma.preoperativeAssessment.create({ data: { caseId: id, ageYears, sex: "MALE", diagnosis: "Test", plannedProcedure: "Test" } })
      await prisma.intraoperativeRecord.create({ data: { caseId: id, startedAt: new Date(startedAt), timezone: "UTC", techniques: [], keyEvents: {}, syncRevision: 1 } })
    }
    await withLockedCaseTransaction(adultCase, async tx => {
      await addEvent(tx, adultCase, userId, { id: "a1", type: "vital", ts: "2026-09-10T08:05:00.000Z", systolic: 120, diastolic: 60, heartRate: 70 } as never, "test")
      await addEvent(tx, adultCase, userId, { id: "a2", type: "vital", ts: "2026-09-10T08:10:00.000Z", systolic: 120, diastolic: 60, heartRate: 72 } as never, "test")
      await addEvent(tx, adultCase, userId, { id: "a3", type: "vital", ts: "2026-09-10T08:15:00.000Z", systolic: 200, diastolic: 100, heartRate: 150, autoFilled: true } as never, "test")
      await addEvent(tx, adultCase, userId, { id: "a4", type: "vital", ts: "2026-09-10T08:20:00.000Z", systolic: 90, diastolic: 40, heartRate: 50 } as never, "test")
      await deleteEvent(tx, adultCase, "a4")
    }, { timeout: 20_000 })
    await withLockedCaseTransaction(childCase, async tx => {
      await addEvent(tx, childCase, userId, { id: "c1", type: "vital", ts: "2026-10-10T08:05:00.000Z", heartRate: 110 } as never, "test")
    }, { timeout: 20_000 })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { institutionId } })
    await prisma.intraopAutomationPolicy.deleteMany({})
    await prisma.auditLog.deleteMany({ where: { userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.institution.deleteMany({ where: { id: institutionId } })
    await disconnectClinicalPrismaForTests()
    await prisma.$disconnect()
  })

  it("counts charted readings per band and sign, leaving out copies and deletions", async () => {
    const stats = await lib.vitalStats(prisma, scope, 1)
    expect(stats.ADULT?.sbp).toEqual({ min: 120, counts: [2], cases: 1 })
    expect(stats.ADULT?.map).toEqual({ min: 80, counts: [2], cases: 1 })
    expect(stats.ADULT?.hr).toEqual({ min: 70, counts: [1, 0, 1], cases: 1 })
    expect(stats.PRESCHOOL?.hr).toEqual({ min: 110, counts: [1], cases: 1 })
  })

  it("grows month by month", async () => {
    const history = await lib.vitalStatsHistory(prisma, scope, 3, new Date("2026-10-20T00:00:00.000Z"))
    expect(history.map(entry => entry.month)).toEqual(["2026-08", "2026-09", "2026-10"])
    expect(history[0].stats.ADULT).toBeUndefined()
    expect(history[1].stats.ADULT?.hr?.cases).toBe(1)
    expect(history[1].stats.PRESCHOOL).toBeUndefined()
    expect(history[2].stats.PRESCHOOL?.hr?.cases).toBe(1)
  })

  it("serves the settings, and the counts only once the questions are on", async () => {
    const off = await (await route.GET(new Request("http://localhost/v1/intraop/automation") as never)).json()
    expect(off).toMatchObject({ settings: { enabled: false }, stats: null })
    await lib.saveIntraopAutomation(prisma, { enabled: true, vitalQuestions: { enabled: true } })
    const on = await (await route.GET(new Request("http://localhost/v1/intraop/automation") as never)).json()
    expect(on.settings.vitalQuestions.enabled).toBe(true)
    expect(on.stats.ADULT.sbp).toEqual({ min: 120, counts: [2], cases: 1 })
  })
})
