import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const getAuthUserMock = vi.fn()
// `after` needs a request scope that does not exist here; the audit writes
// this test cares about happen inside the transaction, not in after().
const afterMock = vi.fn((callback: () => unknown) => { void callback() })
vi.mock("next/server", async importOriginal => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: afterMock }
})
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * Overwriting a newer version is allowed, and never silent.
 *
 * `forceUpdate` guarded nine separate conflict returns. Setting it did not just
 * skip the 409 — it erased any record that there had been a conflict at all, so
 * a colleague's edits were replaced with no error, no warning, and nothing
 * afterwards to show it had happened. Any authenticated caller could set it,
 * from the request body or a header.
 *
 * The mechanism stays, because queued offline saves genuinely need it: a phone
 * reconnecting an hour later is stale by definition. What changed is that it is
 * named for what it does and is written down when it takes effect.
 */
describe.skipIf(!runPostgres)("overriding a save conflict", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let patchCase: typeof import("@/app/v1/cases/[id]/route").PATCH
  let disconnectClinicalPrismaForTests:
    typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests

  const suffix = randomUUID()
  const userId = `conflict-user-${suffix}`
  const caseId = `conflict-case-${suffix}`

  function patch(body: unknown, headers: Record<string, string> = {}) {
    return patchCase(
      new Request(`http://localhost/v1/cases/${caseId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }) as never,
      { params: Promise.resolve({ id: caseId }) },
    )
  }

  const preopRevision = async () =>
    (await prisma.preoperativeAssessment.findUniqueOrThrow({ where: { caseId } })).syncRevision

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ PATCH: patchCase } = await import("@/app/v1/cases/[id]/route"))
    ;({ disconnectClinicalPrismaForTests } = await import("@/lib/clinical-transaction"))
    getAuthUserMock.mockResolvedValue({
      id: userId, role: "MEMBER", institutionId: null, institutionName: null,
      firstName: null, lastName: null, title: null, jti: null,
    })
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        name: "Conflict override test",
        passwordHash: "not-a-real-password",
      },
    })
    await prisma.case.create({ data: { id: caseId, userId, createdById: userId, status: "IN_PROGRESS" } })
    await patch({ preop: { asaScore: "II" } })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { id: caseId } })
    await prisma.auditLog.deleteMany({ where: { userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await disconnectClinicalPrismaForTests()
    await prisma.$disconnect()
  })

  it("refuses a save built on a stale revision", async () => {
    const current = await preopRevision()
    const response = await patch({ preop: { asaScore: "III" } }, {
      "x-lospor-preop-revision": String(current - 1),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: "conflict", section: "preop" })
  })

  it("applies the save when the caller acknowledges the conflict", async () => {
    const current = await preopRevision()
    const response = await patch({ preop: { asaScore: "IV" }, overrideConflict: true }, {
      "x-lospor-preop-revision": String(current - 1),
    })
    expect(response.status).toBe(200)
    const stored = await prisma.preoperativeAssessment.findUniqueOrThrow({ where: { caseId } })
    expect(stored.asaScore).toBe("IV")
  })

  it("records that an overwrite happened and what it discarded", async () => {
    await prisma.auditLog.deleteMany({ where: { userId, action: "CASE_CONFLICT_OVERRIDE" } })
    const current = await preopRevision()
    await patch({ preop: { asaScore: "I" }, overrideConflict: true }, {
      "x-lospor-preop-revision": String(current - 1),
    })

    const [entry] = await prisma.auditLog.findMany({
      where: { userId, action: "CASE_CONFLICT_OVERRIDE", entityId: caseId },
      orderBy: { createdAt: "desc" },
      take: 1,
    })
    expect(entry).toBeDefined()
    const detail = entry.detail as { sections: Array<Record<string, unknown>> }
    expect(detail.sections).toHaveLength(1)
    expect(detail.sections[0]).toMatchObject({
      section: "preop",
      reason: "stale_revision",
      clientRevision: current - 1,
      overriddenRevision: current,
    })
  })

  it("writes nothing when there was no conflict to override", async () => {
    await prisma.auditLog.deleteMany({ where: { userId, action: "CASE_CONFLICT_OVERRIDE" } })
    const current = await preopRevision()
    const response = await patch({ preop: { asaScore: "II" }, overrideConflict: true }, {
      "x-lospor-preop-revision": String(current),
    })
    expect(response.status).toBe(200)
    // The flag being set is not itself an override; only actually discarding a
    // newer version is, and an audit log full of non-events is one nobody reads.
    expect(await prisma.auditLog.count({
      where: { userId, action: "CASE_CONFLICT_OVERRIDE" },
    })).toBe(0)
  })

  it("no longer honours the old flag or header", async () => {
    // Both were renamed so a client cannot keep discarding a colleague's work
    // by sending a field that reads like a retry hint.
    const current = await preopRevision()
    const viaBody = await patch({ preop: { asaScore: "V" }, forceUpdate: true }, {
      "x-lospor-preop-revision": String(current - 1),
    })
    expect(viaBody.status).toBe(409)

    const viaHeader = await patch({ preop: { asaScore: "V" } }, {
      "x-lospor-preop-revision": String(current - 1),
      "x-lospor-force-update": "true",
    })
    expect(viaHeader.status).toBe(409)
  })
})
