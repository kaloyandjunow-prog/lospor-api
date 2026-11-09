import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"
import { DEFAULT_INTRAOP_AUTOMATION } from "@lospor/core/intraop-automation"

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
  let previousAutomationPolicy: { config: unknown } | null = null

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    lib = await import("@/lib/intraop-automation")
    ;({ addEvent, deleteEvent } = await import("@/lib/case-events"))
    ;({ withLockedCaseTransaction, disconnectClinicalPrismaForTests } = await import("@/lib/clinical-transaction"))
    route = await import("@/app/v1/intraop/automation/route")
    // The policy is intentionally a singleton in the product. A shared dev
    // database may already contain a Status choice, so snapshot it and put the
    // deterministic Core default in place before asserting the no-vital-stats
    // response. Teardown restores the operator's previous choice instead of
    // deleting it.
    previousAutomationPolicy = await prisma.intraopAutomationPolicy.findUnique({
      where: { id: "local" },
      select: { config: true },
    })
    await lib.saveIntraopAutomation(prisma, DEFAULT_INTRAOP_AUTOMATION)
    getAuthUserMock.mockResolvedValue({
      id: userId, role: "MEMBER", institutionId, institutionName: null,
      firstName: null, lastName: null, title: null, jti: null,
    })
    await prisma.institution.create({ data: { id: institutionId, name: `Automation ${suffix}`, city: "Sofia" } })
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, username: userId, usernameCanonical: userId.toLowerCase(), name: "Automation test", passwordHash: "not-a-real-password", institutionId } })
    for (const [id, ageYears, startedAt] of [[adultCase, 40, "2026-09-10T08:00:00.000Z"], [childCase, 4, "2026-10-10T08:00:00.000Z"]] as const) {
      await prisma.case.create({ data: { id, userId, createdById: userId, institutionId, status: "IN_PROGRESS" } })
      await prisma.preoperativeAssessment.create({ data: { caseId: id, ageYears, sex: "MALE", diagnosis: "Test", plannedProcedure: "Test" } })
      await prisma.intraoperativeRecord.create({ data: {
        caseId: id,
        startedAt: new Date(startedAt),
        timezone: "UTC",
        techniques: id === adultCase ? ["GENERAL_TIVA"] : [],
        airwayDeviceEntries: id === adultCase ? [{ id: "airway-1", device: "ORAL_ETT", details: {}, insertedAt: "2026-09-10T08:01:00.000Z", status: "in_use" }] : [],
        vascularAccesses: id === adultCase ? [{ id: "line-1", type: "VENOUS", site: "VEN_PERIPHERAL", insertedAt: "2026-09-10T08:02:00.000Z", preexisting: false }] : [],
        keyEvents: {},
        syncRevision: 1,
      } })
    }
    await withLockedCaseTransaction(adultCase, async tx => {
      await addEvent(tx, adultCase, userId, { id: "a1", type: "vital", ts: "2026-09-10T08:05:00.000Z", systolic: 120, diastolic: 60, heartRate: 70 } as never, "test")
      await addEvent(tx, adultCase, userId, { id: "a2", type: "vital", ts: "2026-09-10T08:10:00.000Z", systolic: 120, diastolic: 60, heartRate: 72 } as never, "test")
      await addEvent(tx, adultCase, userId, { id: "a3", type: "vital", ts: "2026-09-10T08:15:00.000Z", systolic: 200, diastolic: 100, heartRate: 150, autoFilled: true } as never, "test")
      await addEvent(tx, adultCase, userId, { id: "a4", type: "vital", ts: "2026-09-10T08:20:00.000Z", systolic: 90, diastolic: 40, heartRate: 50 } as never, "test")
      await deleteEvent(tx, adultCase, "a4")
      await addEvent(tx, adultCase, userId, { id: "a5", type: "clinical_event", label: "Intubated", ts: "2026-09-10T08:01:00.000Z" } as never, "test")
      await addEvent(tx, adultCase, userId, { id: "a6", type: "clinical_event", label: "Positioned", ts: "2026-09-10T08:20:00.000Z" } as never, "test")
      await addEvent(tx, adultCase, userId, { id: "a7", type: "clinical_event", label: "Incision", ts: "2026-09-10T08:26:00.000Z", suggestion: "succession:Positioned>Incision" } as never, "test")
    }, { timeout: 20_000 })
    await withLockedCaseTransaction(childCase, async tx => {
      await addEvent(tx, childCase, userId, { id: "c1", type: "vital", ts: "2026-10-10T08:05:00.000Z", heartRate: 110 } as never, "test")
      await addEvent(tx, childCase, userId, { id: "c2", type: "prompt_answer", ts: "2026-10-10T08:06:00.000Z", answerKind: "succession", answerFor: "succession:Positioned>Incision", suggestion: "succession:Positioned>Incision", answer: "dismissed" } as never, "test")
    }, { timeout: 20_000 })
    // Both fixtures are finished cases: the child contributes the preschool
    // histogram and the case-scoped succession dismissal below.
    await prisma.case.updateMany({ where: { id: { in: [adultCase, childCase] } }, data: { status: "COMPLETE" } })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { institutionId } })
    await prisma.vitalStatTally.deleteMany({ where: { scopeKey: `institution:${institutionId}` } })
    await prisma.vitalStatTallyScope.deleteMany({ where: { scopeKey: `institution:${institutionId}` } })
    await prisma.vitalStatTallyCase.deleteMany({ where: { scopeKey: `institution:${institutionId}` } })
    if (previousAutomationPolicy) {
      await prisma.intraopAutomationPolicy.upsert({
        where: { id: "local" },
        create: { id: "local", config: previousAutomationPolicy.config as never },
        update: { config: previousAutomationPolicy.config as never },
      })
    } else {
      await prisma.intraopAutomationPolicy.deleteMany({ where: { id: "local" } })
    }
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

  it("keeps a running tally equal to the full count, and takes a reopened case back out", async () => {
    lib.invalidateIntraopAutomationCaches()
    const counted = await lib.countedStats(prisma, scope)
    expect(await lib.vitalStats(prisma, scope, 2)).toEqual(counted)
    // Each finalised case is in the tally exactly once.
    expect(await prisma.vitalStatTallyCase.count({ where: { scopeKey: `institution:${institutionId}` } })).toBe(2)

    // Undo finalisation: the case leaves the statistics in the same transaction.
    await prisma.$transaction(async tx => {
      await tx.case.update({ where: { id: adultCase }, data: { status: "IN_PROGRESS" } })
      await lib.untallyCase(tx as never, adultCase)
    })
    lib.invalidateIntraopAutomationCaches()
    const reopened = await lib.vitalStats(prisma, scope, 3)
    expect(reopened.ADULT).toBeUndefined()
    expect(reopened).toEqual(await lib.countedStats(prisma, scope))

    // Finalised again: counted once more, and a second call adds nothing.
    await prisma.case.update({ where: { id: adultCase }, data: { status: "COMPLETE" } })
    expect(await lib.tallyFinalisedCase(prisma, adultCase)).toBe(true)
    expect(await lib.tallyFinalisedCase(prisma, adultCase)).toBe(false)
    lib.invalidateIntraopAutomationCaches()
    expect(await lib.vitalStats(prisma, scope, 4)).toEqual(counted)
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
    // The questions are on by default (10.2), so "off" is a choice a Status operator makes.
    await lib.saveIntraopAutomation(prisma, { enabled: true, vitalQuestions: { enabled: false } })
    const off = await (await route.GET(new Request("http://localhost/v1/intraop/automation") as never)).json()
    expect(off).toMatchObject({ settings: { enabled: true }, stats: null })
    await lib.saveIntraopAutomation(prisma, { enabled: true, dantroleneVialsMg: [250, 20, 250] })
    const mixedVials = await (await route.GET(new Request("http://localhost/v1/intraop/automation") as never)).json()
    expect(mixedVials.settings.dantroleneVialsMg).toEqual([20, 250])
    await lib.saveIntraopAutomation(prisma, { enabled: true, dantroleneVialsMg: [20] })
    const twentyOnlyVials = await (await route.GET(new Request("http://localhost/v1/intraop/automation") as never)).json()
    expect(twentyOnlyVials.settings.dantroleneVialsMg).toEqual([20])
    await lib.saveIntraopAutomation(prisma, { enabled: true, vitalQuestions: { enabled: true } })
    const on = await (await route.GET(new Request("http://localhost/v1/intraop/automation") as never)).json()
    expect(on.settings.vitalQuestions.enabled).toBe(true)
    expect(on.stats.ADULT.sbp).toEqual({ min: 120, counts: [2], cases: 1 })
    expect(on.succession).toEqual(await lib.successionForClient(prisma, scope))

    // The write must invalidate derived responses immediately, not only after
    // the ten-minute TTL. This also proves that the policy survives a fresh
    // Prisma connection rather than living in the process cache.
    await lib.saveIntraopAutomation(prisma, { enabled: true, groups: { reminders: false }, vitalQuestions: { enabled: true } })
    const disabled = await lib.intraopAutomationForClient(prisma, scope)
    expect(disabled.succession).toBeNull()
    const { PrismaClient } = await import("@/generated/prisma/client")
    const { PrismaPg } = await import("@prisma/adapter-pg")
    const fresh = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) })
    try {
      expect((await lib.readIntraopAutomation(fresh)).groups.reminders).toBe(false)
    } finally {
      await fresh.$disconnect()
    }
    await lib.saveIntraopAutomation(prisma, { enabled: true, groups: { reminders: true }, vitalQuestions: { enabled: true } })
  })

  it("learns from finished cases, includes structured airway/vascular records, and excludes wrong scopes", async () => {
    lib.invalidateIntraopAutomationCaches()
    const links = await lib.learnedSuccession(prisma, scope, Date.parse("2026-11-03T00:00:00.000Z"))
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "Intubated", to: "IV line in" }),
      expect.objectContaining({ from: "Positioned", to: "Incision", gapMinutes: 6 }),
    ]))
    expect(await lib.learnedSuccession(prisma, { institutionId: `other-${suffix}` }, Date.parse("2026-11-03T00:00:00.000Z"))).toEqual([])
  })

  it("counts accepted provenance and definitive case-scoped succession dismissal", async () => {
    lib.invalidateIntraopAutomationCaches()
    const result = await lib.suggestionAcceptance(prisma, 90, Date.parse("2026-11-03T00:00:00.000Z"))
    expect(result.byId["succession:Positioned>Incision"]).toEqual({ accepted: 1, dismissed: 1 })
  })
})
