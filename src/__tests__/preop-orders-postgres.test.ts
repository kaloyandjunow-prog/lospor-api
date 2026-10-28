import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"
import { holdPostgresSuiteLock } from "./postgres-suite-lock"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * Ward orders and medication instructions (migration 20261026120000) against a
 * real database: the profile rows are provisioned from Core, a case's orders
 * save in the case's own transaction, and a finalised case refuses them like
 * every other clinical table.
 */
describe.skipIf(!runPostgres)("preop ward orders and medication instructions in PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let service: typeof import("@/lib/preop/service")
  let withLockedCaseTransaction: typeof import("@/lib/clinical-transaction").withLockedCaseTransaction
  let disconnectClinicalPrismaForTests: typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests

  const suffix = randomUUID()
  const userId = `preop-orders-user-${suffix}`
  const caseIds: string[] = []

  async function caseWithPreop() {
    const caseId = `preop-orders-case-${randomUUID()}`
    caseIds.push(caseId)
    await prisma.case.create({ data: { id: caseId, userId, createdById: userId, status: "IN_PROGRESS", clinicalMode: "ADULT" } })
    const preop = await prisma.preoperativeAssessment.create({ data: { caseId, sex: "FEMALE", diagnosis: "Test", plannedProcedure: "Test" } })
    return { caseId, preopId: preop.id }
  }

  const save = (caseId: string, preopId: string, fields: Partial<Parameters<typeof service.savePreopOrders>[1]>) =>
    withLockedCaseTransaction(caseId, tx => service.savePreopOrders(tx, {
      caseId, preopId, actorId: userId, clinicalMode: "ADULT", wardOrders: undefined, medicationInstructions: undefined, premedicationOrders: undefined, ...fields,
    }))

  let releaseLock: (() => Promise<void>) | undefined

  beforeAll(async () => {
    releaseLock = await holdPostgresSuiteLock("preop-profile")
    ;({ prisma } = await import("@/lib/prisma"))
    service = await import("@/lib/preop/service")
    ;({ withLockedCaseTransaction, disconnectClinicalPrismaForTests } = await import("@/lib/clinical-transaction"))
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        username: userId,
        usernameCanonical: userId.toLowerCase(),
        name: "Preop orders test",
        passwordHash: "not-a-real-password",
      },
    })
    await service.preparePreopProfile(prisma, userId)
  })

  afterEach(async () => {
    await prisma.case.deleteMany({ where: { id: { in: caseIds.splice(0) } } })
  })

  afterAll(async () => {
    try {
      if (!prisma) return
      await prisma.user.deleteMany({ where: { id: userId } })
      await disconnectClinicalPrismaForTests()
      await prisma.$disconnect()
    } finally {
      await releaseLock?.()
    }
  })

  it("provisions every section, bundled row and specialty for both populations", async () => {
    const profiles = await service.readPreopProfiles(prisma)
    const shape = service.serializePreopProfiles(profiles!)
    expect(shape.sectionConfigs?.ADULT?.sections.WARD_ORDERS).toBe(true)
    expect(shape.sectionConfigs?.PEDIATRIC?.sections.PEDIATRIC_FASTING).toBe(true)
    expect(shape.sectionConfigs?.ADULT?.orderOptions.map(option => option.key)).toContain("STOP_BEFORE_SURGERY")
    expect(shape.sectionConfigs?.ADULT?.consultSpecialtyKeys).toHaveLength(61)
    expect(await prisma.preopProfileConsultSpecialty.count({ where: { profileId: profiles!.ADULT.id } })).toBe(168)
  })

  it("saves orders and instructions, and bumps the case revision", async () => {
    const { caseId, preopId } = await caseWithPreop()
    const before = (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).clinicalRevision
    await save(caseId, preopId, {
      wardOrders: [{ optionKey: "CONSULTATION", specialtyKey: "1004" }, { optionKey: "MORNING_SERUM_GLUCOSE" }],
      medicationInstructions: [{ id: "row-1", optionKey: "STOP_BEFORE_SURGERY", medicationLabel: "Metformin", medicationInn: "metformin", hoursBefore: 48 }],
    })
    const orders = await prisma.preopWardOrder.findMany({ where: { preopId }, orderBy: { createdAt: "asc" } })
    expect(orders.map(row => [row.optionKey, row.specialtyLabelBg ?? row.labLoinc])).toEqual([["CONSULTATION", "Вътрешни болести"], ["MORNING_SERUM_GLUCOSE", "14749-6"]])
    expect(await prisma.preopMedicationInstruction.findFirst({ where: { preopId } })).toMatchObject({ clientId: "row-1", hoursBefore: 48, conceptId: 764611 })
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).clinicalRevision).toBeGreaterThan(before)
  })

  it("refuses every order write once the case is finalised", async () => {
    const { caseId, preopId } = await caseWithPreop()
    await save(caseId, preopId, {
      wardOrders: [{ optionKey: "CORRECT_ANAEMIA" }],
      medicationInstructions: [{ id: "row-1", optionKey: "DO_NOT_STOP", medicationLabel: "Bisoprolol" }],
    })
    await prisma.case.update({ where: { id: caseId }, data: { status: "COMPLETE" } })
    const order = await prisma.preopWardOrder.findFirstOrThrow({ where: { preopId } })
    const instruction = await prisma.preopMedicationInstruction.findFirstOrThrow({ where: { preopId } })
    await expect(prisma.preopWardOrder.update({ where: { id: order.id }, data: { status: "CANCELLED" } })).rejects.toThrow(/CASE_FINALIZED/)
    await expect(prisma.preopWardOrder.create({ data: { preopId, caseId, optionKey: "X", kind: "SIMPLE", labelEn: "X", labelBg: "X" } })).rejects.toThrow(/CASE_FINALIZED/)
    await expect(prisma.preopMedicationInstruction.delete({ where: { id: instruction.id } })).rejects.toThrow(/CASE_FINALIZED/)
  })

  it("orders premedication a drug per row, keeps a drug still ordered, and refuses it once finalised", async () => {
    const { caseId, preopId } = await caseWithPreop()
    await save(caseId, preopId, { premedicationOrders: { DAY_BEFORE: "Midazolam 7.5 mg PO", MORNING: "Pantoprazole 40 mg PO" } })
    const first = await prisma.preopPremedicationOrder.findFirstOrThrow({ where: { preopId, phase: "DAY_BEFORE" } })
    expect(first).toMatchObject({ drug: "Midazolam", atcCode: "N05CD08", dose: 7.5, unit: "mg", route: "PO", status: "ACTIVE", authorId: userId })
    await save(caseId, preopId, { premedicationOrders: { DAY_BEFORE: "Midazolam 7.5 mg PO; Diazepam 5 mg PO", MORNING: "" } })
    const rows = await prisma.preopPremedicationOrder.findMany({ where: { preopId, status: "ACTIVE" } })
    expect(rows.map(row => row.entry).sort()).toEqual(["Diazepam 5 mg PO", "Midazolam 7.5 mg PO"])
    expect(rows.find(row => row.entry === "Midazolam 7.5 mg PO")!.id).toBe(first.id)
    expect(await prisma.preopPremedicationOrder.count({ where: { preopId, status: "CANCELLED" } })).toBe(1)
    await prisma.case.update({ where: { id: caseId }, data: { status: "COMPLETE" } })
    await expect(prisma.preopPremedicationOrder.update({ where: { id: first.id }, data: { status: "CANCELLED" } })).rejects.toThrow(/CASE_FINALIZED/)
  })

  it("lets an operator switch a section off, add a row of the hospital's own, and change it back", async () => {
    const before = (await service.activePreopProfile(prisma, "ADULT", true))!
    const shape = service.serializePreopProfile(before).sectionConfig!
    const options = shape.orderOptions
      .filter(option => option.key !== "CUSTOM_ECG")
      .map(option => ({ key: option.key, list: option.list, enabled: option.enabled, labelEn: option.labelEn, labelBg: option.labelBg, hoursMode: option.hoursMode }))
    try {
      const changed = await prisma.$transaction(tx => service.updatePreopSectionConfig(tx, userId, {
        sections: { LABS: false },
        orderOptions: [...options, { key: "CUSTOM_ECG", list: "WARD_ORDER", enabled: true, labelEn: "ECG", labelBg: "ЕКГ" }],
        consultSpecialtyKeys: shape.consultSpecialtyKeys,
      }, "Orders test", "ADULT"))
      const config = service.serializePreopProfile(changed).sectionConfig!
      expect(config.sections.LABS).toBe(false)
      expect(config.orderOptions.find(option => option.key === "CUSTOM_ECG")).toMatchObject({ labelBg: "ЕКГ", bundled: false })
      const audit = await prisma.preopAssessmentAuditEvent.findFirst({ where: { profileId: before.id, action: "PROFILE_SECTIONS_UPDATED" }, orderBy: { createdAt: "desc" } })
      expect(audit?.actorId).toBe(userId)
    } finally {
      await prisma.$transaction(tx => service.updatePreopSectionConfig(tx, userId, {
        sections: shape.sections, orderOptions: options, consultSpecialtyKeys: shape.consultSpecialtyKeys,
      }, "Orders test: restore", "ADULT"))
    }
    expect(await prisma.preopProfileOrderOption.count({ where: { profileId: before.id, key: "CUSTOM_ECG" } })).toBe(0)
  })
})
