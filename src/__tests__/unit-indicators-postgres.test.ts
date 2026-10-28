import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"
import { holdPostgresSuiteLock } from "./postgres-suite-lock"

const { getAuthUserMock } = vi.hoisted(() => ({ getAuthUserMock: vi.fn() }))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * The unit indicators (10.0.0), through their route, over a department of its
 * own: twelve started cases in two theatres by two anaesthesiologists, one
 * planned as not yet known whose procedure done names the operation, and two
 * procedures cancelled. The filters narrow the figures but never their own
 * choices; with colleagues' names off a user can narrow only to themself; the
 * cancellations follow the procedure filter; each case's figures are worked
 * out once and again when the case changes.
 */
describe.skipIf(!runPostgres)("unit indicators, PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let getIndicators: typeof import("@/app/v1/indicators/route").GET
  let saveIndicatorConfig: typeof import("@/lib/indicators").saveIndicatorConfig
  let release: () => Promise<void>
  let policyBefore: { config: unknown } | null = null

  const suffix = randomUUID()
  const institutionId = `ind-inst-${suffix}`
  const meId = `ind-me-${suffix}`
  const colleagueId = `ind-colleague-${suffix}`
  const theatreA = `ind-theatre-a-${suffix}`
  const theatreB = `ind-theatre-b-${suffix}`
  const caseIds: string[] = []
  const day = (n: number, hour = 8) => new Date(Date.UTC(2026, 2, n, hour))

  type Report = {
    cases: number
    activity: { cancelled: { count: number | null; of: number }; cancellationReasons: { key: string; count: number | null }[] }
    time: { durationByProcedure: { procedure: string }[] }
  }
  type Body = {
    pending: number
    filters: { theatres: { id: string; name: string }[]; anaesthesiologists: { id: string; name: string }[]; procedures: string[] }
    report: Report
  }
  const read = async (query: Record<string, string> = {}) => {
    const params = new URLSearchParams({ from: "2026-03-01", to: "2026-03-31", ...query })
    const response = await getIndicators(new Request(`http://localhost/v1/indicators?${params}`) as never)
    return { status: response.status, body: await response.json() as Body }
  }
  const asMe = () => getAuthUserMock.mockResolvedValue({ id: meId, role: "MEMBER", institutionId, institutionName: null, firstName: null, lastName: null, title: null, jti: null })

  async function startedCase(index: number, options: { userId: string; theatreId: string | null; procedure: string | null; performed?: string }) {
    const id = `ind-case-${index}-${suffix}`
    caseIds.push(id)
    const startedAt = day(1 + index)
    await prisma.case.create({ data: {
      id, userId: options.userId, createdById: options.userId, institutionId, operatingTheatreId: options.theatreId,
      status: "IN_PROGRESS", clinicalMode: "ADULT",
    } })
    await prisma.preoperativeAssessment.create({ data: {
      caseId: id, sex: "MALE", diagnosis: "", ageYears: 50, weightKg: 80, heightCm: 180, asaScore: "II",
      plannedProcedure: options.procedure ?? "", proceduresJson: options.procedure ? [{ label: options.procedure }] : undefined,
      procedureUndetermined: options.procedure == null,
    } })
    await prisma.intraoperativeRecord.create({ data: {
      caseId: id, startedAt, endedAt: new Date(startedAt.getTime() + 90 * 60_000), timezone: "Europe/Sofia", techniques: ["GENERAL_BALANCED"], keyEvents: [], syncRevision: 1,
    } })
    await prisma.postoperativeRecord.create({ data: {
      caseId: id, disposition: "WARD", ...(options.performed ? { performedProceduresJson: [{ label: options.performed }] } : {}),
    } })
    // Finalised last: the database refuses new records on a finalised case.
    await prisma.case.update({ where: { id }, data: { status: "COMPLETE", finalizedAt: new Date(startedAt.getTime() + 3 * 3600_000) } })
    return id
  }

  async function cancelledCase(index: number, procedure: string, reason: string) {
    const id = `ind-cancelled-${index}-${suffix}`
    caseIds.push(id)
    await prisma.case.create({ data: {
      id, userId: meId, createdById: meId, institutionId, status: "DRAFT",
    } })
    await prisma.preoperativeAssessment.create({ data: { caseId: id, sex: "FEMALE", diagnosis: "", plannedProcedure: procedure, proceduresJson: [{ label: procedure }] } })
    await prisma.case.update({ where: { id }, data: { status: "CANCELLED", statusBeforeCancel: "DRAFT", cancelledAt: day(20 + index), cancelledById: meId, cancellationReason: reason } })
  }

  beforeAll(async () => {
    release = await holdPostgresSuiteLock("indicators")
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ GET: getIndicators } = await import("@/app/v1/indicators/route"))
    ;({ saveIndicatorConfig } = await import("@/lib/indicators"))
    policyBefore = await prisma.indicatorPolicy.findUnique({ where: { id: "local" }, select: { config: true } })
    await prisma.institution.create({ data: { id: institutionId, name: "Indicators test hospital", city: "Sofia" } })
    for (const [id, name] of [[meId, "Dr Me"], [colleagueId, "Dr Colleague"]]) {
      await prisma.user.create({ data: { id, email: `${id}@example.test`, username: id, usernameCanonical: id.toLowerCase(), name, passwordHash: "not-a-real-password", institutionId } })
    }
    await prisma.operatingTheatre.createMany({ data: [{ id: theatreA, name: `A ${suffix}`, sortOrder: -40 }, { id: theatreB, name: `B ${suffix}`, sortOrder: -35 }] })
    // Six cholecystectomies in theatre A: three each.
    for (let i = 0; i < 6; i += 1) await startedCase(i, { userId: i < 3 ? meId : colleagueId, theatreId: theatreA, procedure: "Cholecystectomy" })
    // Five hernia repairs in theatre B, by the colleague.
    for (let i = 6; i < 11; i += 1) await startedCase(i, { userId: colleagueId, theatreId: theatreB, procedure: "Hernia repair" })
    // Planned as not yet known, no theatre; the procedure done names it.
    await startedCase(11, { userId: meId, theatreId: null, procedure: null, performed: "Exploratory laparotomy" })
    await cancelledCase(0, "Cholecystectomy", "NO_THEATRE_TIME_OR_STAFF")
    await cancelledCase(1, "Hernia repair", "PATIENT_CONDITION")
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { id: { in: caseIds } } })
    await prisma.operatingTheatre.deleteMany({ where: { id: { in: [theatreA, theatreB] } } })
    await prisma.user.deleteMany({ where: { id: { in: [meId, colleagueId] } } })
    await prisma.institution.deleteMany({ where: { id: institutionId } })
    if (policyBefore) await saveIndicatorConfig(prisma, policyBefore.config)
    else await prisma.indicatorPolicy.deleteMany({ where: { id: "local" } })
    await prisma.$disconnect()
    await release?.()
  })

  it("counts the department's started cases, and the cancelled ones against all scheduled", async () => {
    asMe()
    const { status, body } = await read()
    expect(status).toBe(200)
    expect(body.pending).toBe(0)
    expect(body.report.cases).toBe(12)
    expect(body.report.activity.cancelled).toMatchObject({ count: 2, of: 14 })
    // Fewer than five of each reason: named, not counted.
    expect(body.report.activity.cancellationReasons.map(item => [item.key, item.count]).sort())
      .toEqual([["NO_THEATRE_TIME_OR_STAFF", null], ["PATIENT_CONDITION", null]])
  })

  it("groups a case by its procedure done, so one planned as not yet known still has a group", async () => {
    asMe()
    const { body } = await read()
    expect(body.filters.procedures).toEqual(["Cholecystectomy", "Exploratory laparotomy", "Hernia repair"])
    expect(body.report.time.durationByProcedure.map(item => item.procedure).sort()).toEqual(["Cholecystectomy", "Hernia repair"])
  })

  it("narrows by theatre, or to the cases without one, and keeps every theatre on offer", async () => {
    asMe()
    const inA = await read({ theatre: theatreA })
    expect(inA.body.report.cases).toBe(6)
    // The choices are the period's, not the filtered rows': theatre B is still offered.
    expect(inA.body.filters.theatres.map(item => item.id).sort()).toEqual([theatreA, theatreB].sort())
    expect(inA.body.filters.procedures).toHaveLength(3)
    expect((await read({ theatre: "none" })).body.report.cases).toBe(1)
  })

  it("applies the procedure filter to the cancellations as well", async () => {
    asMe()
    const hernia = await read({ procedure: "Hernia repair" })
    expect(hernia.body.report.cases).toBe(5)
    expect(hernia.body.report.activity.cancelled).toMatchObject({ count: 1, of: 6 })
    expect(hernia.body.filters.procedures).toHaveLength(3)
  })

  it("with colleagues' names off, narrows to the user alone and ignores a colleague", async () => {
    asMe()
    await saveIndicatorConfig(prisma, { ...(policyBefore?.config as object ?? {}), namedClinicians: false })
    const all = await read()
    expect(all.body.filters.anaesthesiologists).toEqual([{ id: meId, name: "Dr Me" }])
    expect((await read({ assignee: meId })).body.report.cases).toBe(4)
    // A colleague's id is not a filter while names are off: their figures are not shown by name.
    expect((await read({ assignee: colleagueId })).body.report.cases).toBe(12)
  })

  it("with names on, offers every anaesthesiologist and narrows to any of them", async () => {
    asMe()
    await saveIndicatorConfig(prisma, { ...(policyBefore?.config as object ?? {}), namedClinicians: true })
    const all = await read()
    expect(all.body.filters.anaesthesiologists.map(item => item.name).sort()).toEqual(["Dr Colleague", "Dr Me"])
    expect((await read({ assignee: colleagueId })).body.report.cases).toBe(8)
  })

  it("refuses a period that ends before it starts, or runs past a year", async () => {
    asMe()
    expect((await read({ from: "2026-03-31", to: "2026-03-01" })).status).toBe(400)
    expect((await read({ from: "2025-01-01", to: "2026-03-01" })).status).toBe(400)
  })

  it("works each case's figures out once, and again when the case changes", async () => {
    asMe()
    await read()
    const id = caseIds[0]
    const first = await prisma.caseIndicatorSummary.findUniqueOrThrow({ where: { caseId: id } })
    await read()
    expect((await prisma.caseIndicatorSummary.findUniqueOrThrow({ where: { caseId: id } })).computedAt).toEqual(first.computedAt)
    const { clinicalRevision } = await prisma.case.update({ where: { id }, data: { clinicalRevision: { increment: 1 } }, select: { clinicalRevision: true } })
    await read()
    const again = await prisma.caseIndicatorSummary.findUniqueOrThrow({ where: { caseId: id } })
    expect(again.clinicalRevision).toBe(clinicalRevision)
    expect(again.computedAt.getTime()).toBeGreaterThan(first.computedAt.getTime())
  })
})
