import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

const { getAuthUserMock } = vi.hoisted(() => ({ getAuthUserMock: vi.fn() }))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))

// The database refuses writes to a finalised case as well (its own tests
// cover that). Switched off where a test proves the route's own check: with
// it off, only the route can answer 403.
const databaseLayer = vi.hoisted(() => ({ translate: true }))
vi.mock("@/lib/clinical-transaction", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/clinical-transaction")>()
  return { ...actual, isCaseFinalizedDatabaseError: (error: unknown) => databaseLayer.translate && actual.isCaseFinalizedDatabaseError(error) }
})

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * The preop suggestion routes (9.11.0; coverage review 9.13.0). A case sees
 * only its own suggestions -- once, a case without an assessment was handed
 * every case's -- a suggestion is reviewed only through its own case,
 * accepting one writes it as the answer without overriding the clinician,
 * and a finalised case takes neither.
 */
describe.skipIf(!runPostgres)("preop suggestion routes, PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let savePreopAnswers: typeof import("@/lib/preop/service").savePreopAnswers
  let withLockedCaseTransaction: typeof import("@/lib/clinical-transaction").withLockedCaseTransaction
  let disconnectClinicalPrismaForTests: typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests
  let listSuggestions: typeof import("@/app/v1/cases/[id]/preop-suggestions/route").GET
  let reviewSuggestion: typeof import("@/app/v1/cases/[id]/preop-suggestions/[suggestionId]/route").PATCH

  const suffix = randomUUID()
  const userId = `preop-suggest-user-${suffix}`
  const caseIds: string[] = []

  async function caseWithPreop(withPreop = true) {
    const caseId = `preop-suggest-case-${randomUUID()}`
    caseIds.push(caseId)
    await prisma.case.create({ data: { id: caseId, userId, createdById: userId, status: "IN_PROGRESS", clinicalMode: "ADULT" } })
    if (!withPreop) return { caseId, preopId: null as string | null }
    const preop = await prisma.preoperativeAssessment.create({ data: { caseId, sex: "FEMALE", diagnosis: "Test", plannedProcedure: "Test", smoking: true } })
    await withLockedCaseTransaction(caseId, tx => savePreopAnswers(tx, {
      caseId, preopId: preop.id, actorId: userId, preop: { clinicalMode: "ADULT", smoking: true }, clinicalMode: "ADULT",
    }))
    return { caseId, preopId: preop.id as string | null }
  }

  async function suggest(preopId: string, stableKey: string, proposedState: "YES" | "NO" = "YES") {
    const question = await prisma.preopQuestionDefinition.findUniqueOrThrow({ where: { stableKey } })
    return prisma.preopAssessmentSuggestion.create({
      data: { preopId, questionId: question.id, profileVersion: 1, proposedState, ruleId: `test-${randomUUID()}`, ruleVersion: "1", evidence: {} },
    })
  }

  const list = (caseId: string) => listSuggestions(
    new Request(`http://localhost/v1/cases/${caseId}/preop-suggestions`) as never,
    { params: Promise.resolve({ id: caseId }) },
  )
  const review = (caseId: string, suggestionId: string, body: unknown) => reviewSuggestion(
    new Request(`http://localhost/v1/cases/${caseId}/preop-suggestions/${suggestionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: caseId, suggestionId }) },
  )

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ savePreopAnswers } = await import("@/lib/preop/service"))
    ;({ withLockedCaseTransaction, disconnectClinicalPrismaForTests } = await import("@/lib/clinical-transaction"))
    ;({ GET: listSuggestions } = await import("@/app/v1/cases/[id]/preop-suggestions/route"))
    ;({ PATCH: reviewSuggestion } = await import("@/app/v1/cases/[id]/preop-suggestions/[suggestionId]/route"))
    getAuthUserMock.mockResolvedValue({
      id: userId, role: "MEMBER", institutionId: null, institutionName: null,
      firstName: null, lastName: null, title: null, jti: null,
    })
    await prisma.user.create({
      data: {
        id: userId, email: `${userId}@example.test`, username: userId, usernameCanonical: userId.toLowerCase(),
        name: "Preop suggestion routes test", passwordHash: "not-a-real-password",
      },
    })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.$executeRaw`UPDATE "Case" SET "status" = 'IN_PROGRESS' WHERE "id" = ANY(${caseIds})`.catch(() => {})
    await prisma.case.deleteMany({ where: { id: { in: caseIds } } })
    await prisma.auditLog.deleteMany({ where: { entityId: { in: caseIds } } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await disconnectClinicalPrismaForTests()
    await prisma.$disconnect()
  })

  it("lists only the case's own suggestions, and none for a case with no assessment", async () => {
    const mine = await caseWithPreop()
    const other = await caseWithPreop()
    const bare = await caseWithPreop(false)
    const own = await suggest(mine.preopId!, "A3_UNINTENTIONAL_WEIGHT_LOSS")
    await suggest(other.preopId!, "A3_UNINTENTIONAL_WEIGHT_LOSS")

    const listed = await (await list(mine.caseId)).json() as { id: string }[]
    expect(listed.map(row => row.id)).toEqual([own.id])
    expect(await (await list(bare.caseId)).json()).toEqual([])
  }, 30_000)

  it("reviews a suggestion only through its own case", async () => {
    const mine = await caseWithPreop()
    const other = await caseWithPreop()
    const theirs = await suggest(other.preopId!, "A3_UNINTENTIONAL_WEIGHT_LOSS")
    expect((await review(mine.caseId, theirs.id, { status: "ACCEPTED" })).status).toBe(404)
    expect((await prisma.preopAssessmentSuggestion.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe("PENDING")
  }, 30_000)

  it("accepting writes the answer as the suggestion's; a clinician's own answer is kept", async () => {
    const { caseId, preopId } = await caseWithPreop()
    const weightLoss = await suggest(preopId!, "A3_UNINTENTIONAL_WEIGHT_LOSS")
    expect((await review(caseId, weightLoss.id, { status: "ACCEPTED" })).status).toBe(200)
    const answer = await prisma.preopAssessmentAnswer.findFirstOrThrow({ where: { preopId: preopId!, questionId: weightLoss.questionId } })
    expect(answer).toMatchObject({ state: "YES", source: "suggestion" })

    // Smoking was answered YES by the clinician; a suggestion of NO does not overwrite it.
    const smoking = await suggest(preopId!, "BASE_SMOKING", "NO")
    expect((await review(caseId, smoking.id, { status: "ACCEPTED" })).status).toBe(200)
    const kept = await prisma.preopAssessmentAnswer.findFirstOrThrow({ where: { preopId: preopId!, questionId: smoking.questionId } })
    expect(kept.state).toBe("YES")
  }, 30_000)

  it("refuses a malformed review and any review on a finalised case", async () => {
    const { caseId, preopId } = await caseWithPreop()
    const pending = await suggest(preopId!, "A3_UNINTENTIONAL_WEIGHT_LOSS")
    expect((await review(caseId, pending.id, { status: "MAYBE" })).status).toBe(400)
    await prisma.case.update({ where: { id: caseId }, data: { status: "COMPLETE" } })
    databaseLayer.translate = false
    try {
      expect((await review(caseId, pending.id, { status: "ACCEPTED" })).status).toBe(403)
    } finally {
      databaseLayer.translate = true
    }
  }, 30_000)
})
