import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"
import { holdPostgresSuiteLock } from "./postgres-suite-lock"

const { getAuthUserMock } = vi.hoisted(() => ({ getAuthUserMock: vi.fn() }))

vi.mock("server-only", () => ({}))
vi.mock("next/server", async importOriginal => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: vi.fn() }
})
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * Operating theatres (10.0.0), through the routes the apps call: the site's
 * list, assigning a case's theatre until intraop starts, refusing a change
 * made on an out-of-date view, and a cancelled procedure keeping the theatre
 * it has. The theatres switch is appliance-wide, so the suite takes its lock
 * and puts the switch back.
 */
describe.skipIf(!runPostgres)("operating theatres through their routes, PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let disconnectClinicalPrismaForTests: typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests
  let listTheatres: typeof import("@/app/v1/operating-theatres/route").GET
  let assign: typeof import("@/app/v1/cases/[id]/theatre/route").POST
  let changeOperatingTheatres: typeof import("@/lib/operating-theatres").changeOperatingTheatres
  let release: () => Promise<void>
  let policyBefore: { enabled: boolean } | null = null

  const suffix = randomUUID()
  const ownerId = `theatre-owner-${suffix}`
  const colleagueId = `theatre-colleague-${suffix}`
  const strangerId = `theatre-stranger-${suffix}`
  const institutionId = `theatre-inst-${suffix}`
  const caseId = `theatre-case-${suffix}`
  const cancelledId = `theatre-cancelled-${suffix}`
  const theatreA = `theatre-a-${suffix}`
  const theatreB = `theatre-b-${suffix}`
  const retired = `theatre-retired-${suffix}`
  const asUser = (id: string, role = "MEMBER") => getAuthUserMock.mockResolvedValue({
    id, role, institutionId: id === strangerId ? null : institutionId, institutionName: null, firstName: null, lastName: null, title: null, jti: null,
  })
  const post = async (id: string, body: unknown) => {
    const response = await assign(new Request(`http://localhost/v1/cases/${id}/theatre`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }) as never, { params: Promise.resolve({ id }) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const theatreOf = async (id = caseId) => (await prisma.case.findUniqueOrThrow({ where: { id }, select: { operatingTheatreId: true } })).operatingTheatreId
  const setPolicy = (enabled: boolean) => prisma.$transaction(tx => changeOperatingTheatres(tx, { action: "policy", enabled }))

  beforeAll(async () => {
    release = await holdPostgresSuiteLock("operating-theatres")
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ disconnectClinicalPrismaForTests } = await import("@/lib/clinical-transaction"))
    ;({ GET: listTheatres } = await import("@/app/v1/operating-theatres/route"))
    ;({ POST: assign } = await import("@/app/v1/cases/[id]/theatre/route"))
    ;({ changeOperatingTheatres } = await import("@/lib/operating-theatres"))
    policyBefore = await prisma.operatingTheatrePolicy.findUnique({ where: { id: "local" }, select: { enabled: true } })
    await prisma.institution.create({ data: { id: institutionId, name: "Theatre test hospital", city: "Sofia" } })
    for (const [id, name] of [[ownerId, "Dr Owner"], [colleagueId, "Dr Colleague"], [strangerId, "Dr Stranger"]]) {
      await prisma.user.create({ data: { id, email: `${id}@example.test`, username: id, usernameCanonical: id.toLowerCase(), name, passwordHash: "not-a-real-password", ...(id === strangerId ? {} : { institutionId }) } })
    }
    // Sort orders far below any other suite's, so these lead the list.
    await prisma.operatingTheatre.createMany({ data: [
      { id: theatreA, name: `A ${suffix}`, sortOrder: -30 },
      { id: theatreB, name: `B ${suffix}`, sortOrder: -20 },
      { id: retired, name: `Retired ${suffix}`, sortOrder: -10, active: false },
    ] })
    for (const id of [caseId, cancelledId]) {
      await prisma.case.create({ data: { id, userId: ownerId, createdById: ownerId, institutionId, status: id === cancelledId ? "CANCELLED" : "DRAFT" } })
    }
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { id: { in: [caseId, cancelledId] } } })
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [caseId, cancelledId] } } })
    await prisma.operatingTheatre.deleteMany({ where: { id: { in: [theatreA, theatreB, retired] } } })
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, colleagueId, strangerId] } } })
    await prisma.institution.deleteMany({ where: { id: institutionId } })
    if (policyBefore) await setPolicy(policyBefore.enabled)
    else await prisma.operatingTheatrePolicy.deleteMany({ where: { id: "local" } })
    await disconnectClinicalPrismaForTests()
    await prisma.$disconnect()
    await release?.()
  })

  it("offers nothing while theatres are off, and refuses to assign one", async () => {
    await setPolicy(false)
    asUser(ownerId)
    const list = await listTheatres(new Request("http://localhost/v1/operating-theatres") as never)
    expect(await list.json()).toEqual({ enabled: false, theatres: [] })
    expect(await post(caseId, { theatreId: theatreA })).toMatchObject({ status: 409, body: { code: "OPERATING_THEATRES_OFF" } })
  })

  it("lists the active theatres in order once switched on", async () => {
    await setPolicy(true)
    asUser(ownerId)
    const { enabled, theatres } = await (await listTheatres(new Request("http://localhost/v1/operating-theatres") as never)).json() as { enabled: boolean; theatres: { id: string }[] }
    expect(enabled).toBe(true)
    const ours = theatres.filter(item => [theatreA, theatreB, retired].includes(item.id)).map(item => item.id)
    expect(ours).toEqual([theatreA, theatreB])
  })

  it("lets anyone who can open the case assign a theatre, and audits the change", async () => {
    asUser(ownerId)
    expect(await post(caseId, { theatreId: theatreA, expectedTheatreId: null })).toMatchObject({ status: 200, body: { theatreId: theatreA } })
    expect(await theatreOf()).toBe(theatreA)
    const audit = await prisma.auditLog.findFirst({ where: { entityId: caseId, action: "CASE_THEATRE_ASSIGN" } })
    expect(audit).toMatchObject({ userId: ownerId, detail: { from: null, to: theatreA } })
    // A case outside the user's reach is not found, and nothing changes.
    asUser(strangerId)
    expect(await post(caseId, { theatreId: theatreB })).toMatchObject({ status: 404, body: { code: "CASE_NOT_FOUND" } })
    expect(await theatreOf()).toBe(theatreA)
  })

  it("refuses a change made on an out-of-date view, naming the theatre it has now and who set it", async () => {
    asUser(colleagueId, "HEAD_OF_DEPT")
    const refused = await post(caseId, { theatreId: theatreB, expectedTheatreId: null })
    expect(refused).toMatchObject({ status: 409, body: { code: "THEATRE_CHANGED", current: { id: theatreA, name: `A ${suffix}` }, changedBy: "Dr Owner" } })
    expect(await theatreOf()).toBe(theatreA)
    // Seen as it is, the change goes through.
    expect(await post(caseId, { theatreId: theatreB, expectedTheatreId: theatreA })).toMatchObject({ status: 200, body: { theatreId: theatreB } })
  })

  it("refuses a retired or unknown theatre, and a malformed request", async () => {
    asUser(ownerId)
    expect(await post(caseId, { theatreId: retired })).toMatchObject({ status: 404, body: { code: "THEATRE_NOT_FOUND" } })
    expect(await post(caseId, { theatreId: "no-such-theatre" })).toMatchObject({ status: 404, body: { code: "THEATRE_NOT_FOUND" } })
    expect(await post(caseId, { theatre: theatreA })).toMatchObject({ status: 400 })
    expect(await theatreOf()).toBe(theatreB)
  })

  it("clears the theatre with null", async () => {
    asUser(ownerId)
    expect(await post(caseId, { theatreId: null })).toMatchObject({ status: 200, body: { theatreId: null } })
    expect(await theatreOf()).toBeNull()
  })

  it("keeps a cancelled procedure's theatre, and says the procedure is cancelled", async () => {
    asUser(ownerId)
    expect(await post(cancelledId, { theatreId: theatreA })).toMatchObject({ status: 409, body: { code: "CASE_CANCELLED" } })
    expect(await theatreOf(cancelledId)).toBeNull()
  })

  it("locks the theatre once intraop has started", async () => {
    asUser(ownerId)
    await post(caseId, { theatreId: theatreA })
    await prisma.intraoperativeRecord.create({ data: { caseId, startedAt: new Date(), timezone: "UTC", techniques: [], keyEvents: {}, syncRevision: 1 } })
    expect(await post(caseId, { theatreId: theatreB })).toMatchObject({ status: 409, body: { code: "THEATRE_LOCKED_INTRAOP_STARTED" } })
    expect(await theatreOf()).toBe(theatreA)
  })
})
