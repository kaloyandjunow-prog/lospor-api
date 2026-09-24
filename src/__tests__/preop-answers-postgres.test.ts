import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * The preop answer rows have the same finalization lock as every other
 * clinical table (migration 20260924120000). Before it, the routes checked
 * the case status in code and nothing in the database stood behind them.
 */
describe.skipIf(!runPostgres)("preop answer rows in PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let savePreopAnswers: typeof import("@/lib/preop/service").savePreopAnswers
  let withLockedCaseTransaction: typeof import("@/lib/clinical-transaction").withLockedCaseTransaction
  let disconnectClinicalPrismaForTests: typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests

  const suffix = randomUUID()
  const userId = `preop-answers-user-${suffix}`
  const caseIds: string[] = []

  async function caseWithPreop() {
    const caseId = `preop-answers-case-${randomUUID()}`
    caseIds.push(caseId)
    await prisma.case.create({ data: { id: caseId, userId, createdById: userId, status: "IN_PROGRESS", clinicalMode: "ADULT" } })
    const preop = await prisma.preoperativeAssessment.create({ data: { caseId, sex: "FEMALE", diagnosis: "Test", plannedProcedure: "Test", smoking: true } })
    await withLockedCaseTransaction(caseId, tx => savePreopAnswers(tx, {
      caseId, preopId: preop.id, actorId: userId, preop: { clinicalMode: "ADULT", smoking: true }, clinicalMode: "ADULT",
    }))
    return { caseId, preopId: preop.id }
  }

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ savePreopAnswers } = await import("@/lib/preop/service"))
    ;({ withLockedCaseTransaction, disconnectClinicalPrismaForTests } = await import("@/lib/clinical-transaction"))
    // A username as well as an email: the Hospital database requires one.
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        username: userId,
        usernameCanonical: userId.toLowerCase(),
        name: "Preop answers test",
        passwordHash: "not-a-real-password",
      },
    })
  })

  afterEach(async () => {
    await prisma.case.deleteMany({ where: { id: { in: caseIds.splice(0) } } })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { id: userId } })
    await disconnectClinicalPrismaForTests()
    await prisma.$disconnect()
  })

  it("writes one row per question that is on, and bumps the case revision", async () => {
    const { caseId, preopId } = await caseWithPreop()
    const smoking = await prisma.preopAssessmentAnswer.findFirst({ where: { preopId, question: { stableKey: "BASE_SMOKING" } } })
    expect(smoking?.state).toBe("YES")
    const revisionBefore = (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).clinicalRevision
    await prisma.preopAssessmentAnswer.update({ where: { id: smoking!.id }, data: { state: "NO" } })
    const revisionAfter = (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).clinicalRevision
    expect(revisionAfter).toBeGreaterThan(revisionBefore)
  })

  it("refuses every answer and suggestion write once the case is finalised", async () => {
    const { caseId, preopId } = await caseWithPreop()
    const smoking = await prisma.preopAssessmentAnswer.findFirstOrThrow({ where: { preopId, question: { stableKey: "BASE_SMOKING" } } })
    await prisma.case.update({ where: { id: caseId }, data: { status: "COMPLETE" } })

    await expect(prisma.preopAssessmentAnswer.update({ where: { id: smoking.id }, data: { state: "NO" } }))
      .rejects.toThrow(/CASE_FINALIZED/)
    await expect(prisma.preopAssessmentAnswer.delete({ where: { id: smoking.id } }))
      .rejects.toThrow(/CASE_FINALIZED/)
    const question = await prisma.preopQuestionDefinition.findUniqueOrThrow({ where: { stableKey: "A3_UNINTENTIONAL_WEIGHT_LOSS" } })
    await expect(prisma.preopAssessmentSuggestion.create({
      data: { preopId, questionId: question.id, profileVersion: 1, proposedState: "YES", ruleId: "test", ruleVersion: "1", evidence: {} },
    })).rejects.toThrow(/CASE_FINALIZED/)
  })

  it("keeps exactly one row per case and question", async () => {
    const { preopId } = await caseWithPreop()
    const smoking = await prisma.preopAssessmentAnswer.findFirstOrThrow({ where: { preopId, question: { stableKey: "BASE_SMOKING" } } })
    await expect(prisma.preopAssessmentAnswer.create({
      data: {
        preopId, questionId: smoking.questionId, profileId: smoking.profileId, profileVersion: smoking.profileVersion + 1,
        state: "NO", source: "clinician",
      },
    })).rejects.toThrow()
  })
})
