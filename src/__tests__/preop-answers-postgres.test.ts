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

  // A hosted database that ran 1.4.7 holds the 1.4.7 catalogue and profile.
  // The first save on the new release upgrades them inside the save's own
  // 5-second transaction; row by row that outlived the timeout on Supabase and
  // every save failed with a 500. Recreate that state and upgrade it the same way.
  it("upgrades a previous release's catalogue and profile inside one save transaction", async () => {
    const { ensurePreopProfile } = await import("@/lib/preop/service")
    const { BUNDLED_PREOP_QUESTIONS, PREOP_CATALOG_VERSION } = await import("@/lib/preop/catalog")
    const profile = await prisma.$transaction(tx => ensurePreopProfile(tx, userId))

    // What 1.4.7 left behind: an older catalogue version on every question,
    // a concept the new release corrects, a missing option, and a profile
    // without a question the new release adds.
    const a6 = await prisma.preopQuestionDefinition.findUniqueOrThrow({ where: { stableKey: "A6_POST_ANAESTHESIA_CONFUSION" } })
    await prisma.preopQuestionDefinition.updateMany({ data: { catalogVersion: "1.4.7" } })
    await prisma.preopQuestionDefinition.update({ where: { id: a6.id }, data: { omopConceptId: 4224115 } })
    const dropped = profile.questions.find(row => row.question.stableKey === "P8_DIFFICULT_VENOUS_ACCESS")!
    await prisma.preopProfileQuestion.delete({ where: { profileId_questionId: { profileId: profile.id, questionId: dropped.questionId } } })
    await prisma.preopAnswerOption.deleteMany({ where: { questionId: dropped.questionId, key: "NO" } })
    await prisma.preopAssessmentProfile.update({ where: { id: profile.id }, data: { catalogVersion: "1.4.7" } })

    const started = Date.now()
    const upgraded = await prisma.$transaction(tx => ensurePreopProfile(tx, userId), { timeout: 5_000 })
    expect(Date.now() - started).toBeLessThan(5_000)

    expect(upgraded.catalogVersion).toBe(PREOP_CATALOG_VERSION)
    expect(upgraded.questions).toHaveLength(BUNDLED_PREOP_QUESTIONS.length)
    const readded = upgraded.questions.find(row => row.question.stableKey === "P8_DIFFICULT_VENOUS_ACCESS")!
    expect(readded).toMatchObject({ enabled: false, required: false })
    expect(readded.question.options.map(option => option.key).sort()).toEqual(["NO", "YES"])
    expect(await prisma.preopQuestionDefinition.count({ where: { catalogVersion: { not: PREOP_CATALOG_VERSION } } })).toBe(0)
    const expectedA6 = BUNDLED_PREOP_QUESTIONS.find(item => item.stableKey === "A6_POST_ANAESTHESIA_CONFUSION")!
    expect((await prisma.preopQuestionDefinition.findUniqueOrThrow({ where: { id: a6.id } })).omopConceptId)
      .toBe(expectedA6.omopConceptId ?? null)
    // Existing rows keep their identity, so answers that reference them stay valid.
    expect((await prisma.preopQuestionDefinition.findUniqueOrThrow({ where: { stableKey: "A6_POST_ANAESTHESIA_CONFUSION" } })).id).toBe(a6.id)
  })

  // Production (API far from its database, ~90 ms a round trip) had no
  // catalogue and no profile. A nested profile create took 172 queries, 16 s,
  // and every save failed. Round trips, not rows, are what cost there.
  it("sets up the catalogue and profile on an empty database in a bounded number of queries", async () => {
    const { PrismaClient } = await import("@/generated/prisma/client")
    const { PrismaPg } = await import("@prisma/adapter-pg")
    const { ensurePreopProfile } = await import("@/lib/preop/service")
    const { BUNDLED_PREOP_QUESTIONS } = await import("@/lib/preop/catalog")
    const counted = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 2 }),
      log: [{ emit: "event", level: "query" }],
    })
    let queries = 0
    counted.$on("query" as never, () => { queries += 1 })
    // Measured inside one transaction that is always rolled back: the other
    // PostgreSQL suites run at the same time against the same database, and
    // emptying the catalogue for real would take their answers, profile and
    // case revisions with it. session_replication_role = replica suspends the
    // finalization triggers and foreign keys for this transaction only, so the
    // empty state can be reached even with finalized cases present.
    const ROLLBACK = new Error("measured; roll back")
    let fromEmpty = 0
    let whenSetUp = 0
    let questionCount = 0
    try {
      await counted.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
        await tx.preopAssessmentAnswer.deleteMany({})
        await tx.preopAssessmentSuggestion.deleteMany({})
        await tx.preopProfileQuestion.deleteMany({})
        await tx.preopAssessmentAuditEvent.deleteMany({})
        await tx.preopAssessmentProfile.deleteMany({})
        await tx.preopAnswerOption.deleteMany({})
        await tx.preopQuestionDefinition.deleteMany({})
        queries = 0
        const profile = await ensurePreopProfile(tx, userId)
        fromEmpty = queries
        questionCount = profile.questions.length
        queries = 0
        await ensurePreopProfile(tx, userId)
        whenSetUp = queries
        throw ROLLBACK
      }, { timeout: 30_000 }).catch(error => { if (error !== ROLLBACK) throw error })
    } finally {
      await counted.$disconnect()
    }
    expect(questionCount).toBe(BUNDLED_PREOP_QUESTIONS.length)
    expect(fromEmpty).toBeLessThanOrEqual(30)
    expect(whenSetUp).toBeLessThanOrEqual(6)
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
