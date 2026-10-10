import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * One profile for adults and one for children (9.14.5), against a real
 * database: an operator reorders the paediatric profile, makes a question
 * required, then switches it off, and only paediatric cases follow. The
 * profiles are appliance-wide, so their settings are restored afterwards.
 */
describe.skipIf(!runPostgres)("adult and paediatric preop profiles in PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let service: typeof import("@/lib/preop/service")
  let withLockedCaseTransaction: typeof import("@/lib/clinical-transaction").withLockedCaseTransaction
  let disconnectClinicalPrismaForTests: typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests

  const suffix = randomUUID()
  const userId = `preop-profiles-user-${suffix}`
  const caseIds: string[] = []
  let saved: Array<{ profileId: string; questionId: string; enabled: boolean; required: boolean; sortOrder: number }> = []

  type Settings = { stableKey: string; enabled: boolean; required: boolean; sortOrder: number }
  const settingsOf = (profile: Awaited<ReturnType<typeof service.ensurePreopProfile>>): Settings[] => profile.questions
    .filter(row => service.questionAppliesToPopulation(row.question.applicability, profile.population))
    .map(row => ({ stableKey: row.question.stableKey, enabled: row.enabled, required: row.required, sortOrder: row.sortOrder }))

  async function update(population: "ADULT" | "PEDIATRIC", change: (list: Settings[]) => Settings[]) {
    return prisma.$transaction(async tx => {
      const profile = await service.ensurePreopProfile(tx, userId, population)
      return service.updatePreopProfile(tx, userId, change(settingsOf(profile)), "Profile test change", population)
    })
  }

  async function caseOf(mode: "ADULT" | "PEDIATRIC") {
    const caseId = `preop-profiles-case-${randomUUID()}`
    caseIds.push(caseId)
    await prisma.case.create({ data: { id: caseId, userId, createdById: userId, status: "IN_PROGRESS", clinicalMode: mode } })
    const preop = await prisma.preoperativeAssessment.create({ data: { caseId, sex: "FEMALE", diagnosis: "Test", plannedProcedure: "Test" } })
    const save = () => withLockedCaseTransaction(caseId, tx => service.savePreopAnswers(tx, {
      caseId, preopId: preop.id, actorId: userId, preop: { clinicalMode: mode }, clinicalMode: mode,
    }))
    const rows = () => prisma.preopAssessmentAnswer.findMany({ where: { preopId: preop.id }, include: { question: { select: { stableKey: true } } } })
    const missing = async () => {
      const profiles = await service.readPreopProfiles(prisma)
      const answers = await prisma.preopAssessmentAnswer.findMany({ where: { preopId: preop.id }, select: { questionId: true, state: true } })
      return service.missingRequiredPreopQuestions(profiles?.[service.populationForMode(mode)], answers, mode).map(item => item.stableKey)
    }
    await save()
    return { save, rows, missing }
  }

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    service = await import("@/lib/preop/service")
    ;({ withLockedCaseTransaction, disconnectClinicalPrismaForTests } = await import("@/lib/clinical-transaction"))
    await prisma.user.create({
      data: {
        id: userId, email: `${userId}@example.test`, username: userId, usernameCanonical: userId.toLowerCase(),
        name: "Preop profiles test", passwordHash: "not-a-real-password",
      },
    })
    await service.preparePreopProfile(prisma, userId)
    saved = await prisma.preopProfileQuestion.findMany({ select: { profileId: true, questionId: true, enabled: true, required: true, sortOrder: true } })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { id: { in: caseIds } } })
    for (const row of saved) {
      await prisma.preopProfileQuestion.update({
        where: { profileId_questionId: { profileId: row.profileId, questionId: row.questionId } },
        data: { enabled: row.enabled, required: row.required, sortOrder: row.sortOrder },
      })
    }
    await prisma.preopAssessmentAuditEvent.deleteMany({ where: { actorId: userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await disconnectClinicalPrismaForTests()
    await prisma.$disconnect()
  })

  it("keeps one published profile per population", async () => {
    const both = await prisma.$transaction(tx => service.ensurePreopProfiles(tx, userId))
    expect(both.ADULT.population).toBe("ADULT")
    expect(both.PEDIATRIC.population).toBe("PEDIATRIC")
    expect(both.ADULT.id).not.toBe(both.PEDIATRIC.id)
    await expect(prisma.preopAssessmentProfile.create({
      data: { version: 999_999, population: "PEDIATRIC", catalogVersion: "test", status: "PUBLISHED" },
    })).rejects.toThrow()
  })

  it("reorders, requires and then switches off a question for children only", async () => {
    const child = await caseOf("PEDIATRIC")
    const adult = await caseOf("ADULT")
    expect((await child.rows()).some(row => row.question.stableKey === "P2_HOME_OXYGEN_NIV")).toBe(false)

    // Move "home oxygen" to the top of the children's list, switch it on and make it required.
    const reordered = await update("PEDIATRIC", list => {
      const others = list.filter(item => item.stableKey !== "P2_HOME_OXYGEN_NIV").sort((a, b) => a.sortOrder - b.sortOrder)
      const target = list.find(item => item.stableKey === "P2_HOME_OXYGEN_NIV")!
      return [{ ...target, enabled: true, required: true, sortOrder: 0 }, ...others.map((item, index) => ({ ...item, sortOrder: index + 1 }))]
    })
    const first = [...reordered.questions].filter(row => row.enabled).sort((a, b) => a.sortOrder - b.sortOrder)[0]!
    expect(first.question.stableKey).toBe("P2_HOME_OXYGEN_NIV")

    // The forms receive it in the children's settings, and not the adults'.
    const shape = service.serializePreopProfiles((await service.readPreopProfiles(prisma))!)
    const oxygen = shape.questions.find(item => item.stableKey === "P2_HOME_OXYGEN_NIV")!
    expect(oxygen.byMode).toEqual({ PEDIATRIC: { enabled: true, required: true, sortOrder: 0 } })

    await child.save()
    expect((await child.rows()).find(row => row.question.stableKey === "P2_HOME_OXYGEN_NIV")?.state).toBe("NOT_ASKED")
    expect(await child.missing()).toContain("P2_HOME_OXYGEN_NIV")
    expect(await adult.missing()).not.toContain("P2_HOME_OXYGEN_NIV")

    // A shared question made required for children stays optional for adults.
    await update("PEDIATRIC", list => list.map(item => item.stableKey === "BASE_LATEX_ALLERGY" ? { ...item, enabled: true, required: true } : item))
    await child.save()
    await adult.save()
    expect(await child.missing()).toContain("BASE_LATEX_ALLERGY")
    expect(await adult.missing()).not.toContain("BASE_LATEX_ALLERGY")

    // Switched off: no longer asked, no longer required, and its unanswered row goes.
    await update("PEDIATRIC", list => list.map(item => item.stableKey === "P2_HOME_OXYGEN_NIV" ? { ...item, enabled: false, required: false } : item))
    await child.save()
    expect((await child.rows()).some(row => row.question.stableKey === "P2_HOME_OXYGEN_NIV")).toBe(false)
    expect(await child.missing()).not.toContain("P2_HOME_OXYGEN_NIV")

    // The children's rows were recorded under the children's profile.
    const latex = (await child.rows()).find(row => row.question.stableKey === "BASE_LATEX_ALLERGY")!
    expect(latex.profileId).toBe((await service.activePreopProfile(prisma, "PEDIATRIC"))!.id)
  })

  it("refuses a children's change that names an adult-only question", async () => {
    await expect(update("PEDIATRIC", list => [...list, { stableKey: "A1_RECENT_INFECTION", enabled: true, required: false, sortOrder: 10_000 }]))
      .rejects.toMatchObject({ code: "PREOP_QUESTION_OTHER_POPULATION" })
  })

  it("starts the children's profile as a copy of the existing one when upgrading", async () => {
    // Rolled back: the profiles are shared with the other suites.
    const ROLLBACK = new Error("measured; roll back")
    let copied: { required: boolean; sortOrder: number } | undefined
    let adultSetting: { required: boolean; sortOrder: number } | undefined
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      const adult = await service.ensurePreopProfile(tx, userId, "ADULT")
      const smoking = adult.questions.find(row => row.question.stableKey === "BASE_SMOKING")!
      await tx.preopProfileQuestion.update({
        where: { profileId_questionId: { profileId: adult.id, questionId: smoking.questionId } },
        data: { required: true, sortOrder: 4_321 },
      })
      adultSetting = { required: true, sortOrder: 4_321 }
      const pediatric = await service.activePreopProfile(tx, "PEDIATRIC")
      await tx.preopProfileQuestion.deleteMany({ where: { profileId: pediatric!.id } })
      await tx.preopAssessmentProfile.delete({ where: { id: pediatric!.id } })
      const both = await service.ensurePreopProfiles(tx, userId)
      const row = both.PEDIATRIC.questions.find(item => item.question.stableKey === "BASE_SMOKING")!
      copied = { required: row.required, sortOrder: row.sortOrder }
      throw ROLLBACK
    }, { timeout: 30_000 }).catch(error => { if (error !== ROLLBACK) throw error })
    expect(copied).toEqual(adultSetting)
  })
})
