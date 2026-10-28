import { describe, expect, it, vi } from "vitest"
import { ClinicalMode } from "@/generated/prisma/client"
import { DEFAULT_CONSULT_SPECIALTY_KEYS, NHIS_SPECIALTIES } from "@lospor/core/nhis-specialties"
import { BUNDLED_PREOP_ORDER_OPTIONS, defaultPreopSectionConfig, preopSectionsFor, type PreopSectionConfig } from "@lospor/core/preop-orders"
import {
  saveMedicationInstructions,
  savePremedicationOrders,
  saveWardOrders,
  serializePremedicationOrders,
  sectionConfigOf,
  sectionRowsCurrent,
  updateSectionRows,
  type ProfileSectionRows,
} from "./sections"

type Db = Parameters<typeof saveWardOrders>[0]
type OrderRow = Record<string, unknown> & { id: string; status: string; optionKey: string; specialtyKey: string | null; labTest: string | null }
type InstructionRow = Record<string, unknown> & { id: string; clientId: string; status: string }

/** A stand-in for the two order tables that behaves like the real ones. */
function orderDb() {
  const orders: OrderRow[] = []
  const instructions: InstructionRow[] = []
  let next = 0
  const db = {
    preopWardOrder: {
      findMany: vi.fn(async ({ where }: { where: { status?: string } }) => orders.filter(row => !where.status || row.status === where.status)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { specialtyKey: null, labTest: null, ...data, id: `o${next++}`, status: "ACTIVE" } as OrderRow
        orders.push(row)
        return row
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        for (const row of orders) if (where.id.in.includes(row.id)) Object.assign(row, data)
        return { count: where.id.in.length }
      }),
    },
    preopMedicationInstruction: {
      findMany: vi.fn(async () => instructions),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `i${next++}`, status: "ACTIVE" } as InstructionRow
        instructions.push(row)
        return row
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = instructions.find(item => item.id === where.id)!
        Object.assign(row, data)
        return row
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        for (const row of instructions) if (where.id.in.includes(row.id)) Object.assign(row, data)
        return { count: where.id.in.length }
      }),
    },
    labLoinc: { findUnique: vi.fn(async ({ where }: { where: { name: string } }) => where.name === "Potassium (K⁺)" ? { loincCode: "2823-3" } : null) },
    conceptMap: { findFirst: vi.fn(async () => ({ standardConceptId: 3023103 })) },
  } as unknown as Db
  return { db, orders, instructions }
}

const ward = (db: Db, orders: Parameters<typeof saveWardOrders>[1]["orders"], config: PreopSectionConfig = defaultPreopSectionConfig("ADULT")) =>
  saveWardOrders(db, { caseId: "case-1", preopId: "preop-1", actorId: "dr-1", population: ClinicalMode.ADULT, config, orders })
const meds = (db: Db, instructions: Parameters<typeof saveMedicationInstructions>[1]["instructions"], config: PreopSectionConfig = defaultPreopSectionConfig("ADULT")) =>
  saveMedicationInstructions(db, { caseId: "case-1", preopId: "preop-1", actorId: "dr-1", config, instructions })

describe("a case's ward orders", () => {
  it("keeps its own copy of what was ordered: labels, concept, specialty names, the test's codes", async () => {
    const { db, orders } = orderDb()
    await ward(db, [
      { optionKey: "CORRECT_ELECTROLYTES" },
      { optionKey: "CONSULTATION", specialtyKey: "1004" },
      { optionKey: "INVESTIGATE", labTest: "Potassium (K⁺)" },
      { optionKey: "MORNING_SERUM_GLUCOSE" },
    ])
    expect(orders).toHaveLength(4)
    expect(orders[0]).toMatchObject({ optionKey: "CORRECT_ELECTROLYTES", labelEn: "Correct electrolyte disturbances", labelBg: "Корекция на дисйонемия", conceptId: 4171615, authorId: "dr-1" })
    expect(orders[1]).toMatchObject({ kind: "CONSULT", specialtyKey: "1004", specialtyLabelEn: "Internal diseases", specialtyLabelBg: "Вътрешни болести" })
    expect(orders[2]).toMatchObject({ labTest: "Potassium (K⁺)", labLoinc: "2823-3", labConceptId: 3023103 })
    // Serum glucose, whatever the library's glucose maps to.
    expect(orders[3]).toMatchObject({ labTest: "Glucose", labLoinc: "14749-6", labConceptId: 3013826 })
  })

  it("cancels an order unticked, leaves the rest alone, and places it again as a new row", async () => {
    const { db, orders } = orderDb()
    await ward(db, [{ optionKey: "CORRECT_ANAEMIA" }, { optionKey: "CORRECT_ACID_BASE" }])
    await ward(db, [{ optionKey: "CORRECT_ACID_BASE" }])
    expect(orders.map(row => [row.optionKey, row.status])).toEqual([["CORRECT_ANAEMIA", "CANCELLED"], ["CORRECT_ACID_BASE", "ACTIVE"]])
    expect(orders[0]!.cancelledAt).toBeInstanceOf(Date)
    await ward(db, [{ optionKey: "CORRECT_ACID_BASE" }, { optionKey: "CORRECT_ANAEMIA" }])
    expect(orders.map(row => [row.optionKey, row.status])).toEqual([["CORRECT_ANAEMIA", "CANCELLED"], ["CORRECT_ACID_BASE", "ACTIVE"], ["CORRECT_ANAEMIA", "ACTIVE"]])
  })

  it("does nothing when the form does not send the list, or the section is off", async () => {
    const { db, orders } = orderDb()
    await ward(db, [{ optionKey: "CORRECT_ANAEMIA" }])
    await ward(db, undefined)
    const off = defaultPreopSectionConfig("ADULT")
    off.sections.WARD_ORDERS = false
    await ward(db, [], off)
    expect(orders.map(row => row.status)).toEqual(["ACTIVE"])
  })

  it("refuses what Core refuses, naming the problems", async () => {
    const { db } = orderDb()
    await expect(ward(db, [{ optionKey: "NO_ADDITIONAL_ORDERS" }, { optionKey: "CORRECT_ANAEMIA" }]))
      .rejects.toMatchObject({ code: "PREOP_WARD_ORDERS_REFUSED", details: { problems: [{ code: "NONE_WITH_OTHERS" }] } })
  })

  it("keeps an order the hospital has since switched off", async () => {
    const { db, orders } = orderDb()
    await ward(db, [{ optionKey: "CORRECT_ANAEMIA" }])
    const config = defaultPreopSectionConfig("ADULT")
    config.orderOptions = config.orderOptions.map(option => option.key === "CORRECT_ANAEMIA" ? { ...option, enabled: false } : option)
    await ward(db, [{ optionKey: "CORRECT_ANAEMIA" }, { optionKey: "CORRECT_ACID_BASE" }], config)
    expect(orders.filter(row => row.status === "ACTIVE")).toHaveLength(2)
  })
})

describe("a case's medication instructions", () => {
  const stop = { id: "row-a", optionKey: "STOP_BEFORE_SURGERY", medicationLabel: "Metformin", medicationInn: "metformin", hoursBefore: 48 }

  it("matches rows by the form's id, so an autosave never doubles one", async () => {
    const { db, instructions } = orderDb()
    await meds(db, [stop])
    await meds(db, [stop])
    expect(instructions).toHaveLength(1)
    expect(instructions[0]).toMatchObject({ clientId: "row-a", labelEn: "Stop taking", conceptId: 764611, hoursBefore: 48, medicationInn: "metformin" })
    expect(vi.mocked(db.preopMedicationInstruction.update)).not.toHaveBeenCalled()
  })

  it("updates a changed row in place and cancels one the form dropped", async () => {
    const { db, instructions } = orderDb()
    await meds(db, [stop, { ...stop, id: "row-b", optionKey: "DO_NOT_STOP", medicationLabel: "Bisoprolol", medicationInn: null, hoursBefore: null }])
    await meds(db, [{ ...stop, hoursBefore: 72 }])
    expect(instructions.map(row => [row.clientId, row.status, row.hoursBefore])).toEqual([["row-a", "ACTIVE", 72], ["row-b", "CANCELLED", null]])
  })

  it("refuses a stop with no hours", async () => {
    const { db } = orderDb()
    await expect(meds(db, [{ ...stop, hoursBefore: null }])).rejects.toMatchObject({ code: "PREOP_MEDICATION_INSTRUCTIONS_REFUSED" })
  })
})

/** A provisioned profile's rows, adjustable. */
function rows(population: "ADULT" | "PEDIATRIC" = "ADULT"): Required<ProfileSectionRows> {
  const defaults = new Set(DEFAULT_CONSULT_SPECIALTY_KEYS)
  return {
    sections: preopSectionsFor(population).map(section => ({ sectionKey: section.key as string, enabled: true })),
    orderOptions: BUNDLED_PREOP_ORDER_OPTIONS.map(option => ({ ...option })),
    consultSpecialties: NHIS_SPECIALTIES.map(item => ({ specialtyKey: item.key, enabled: defaults.has(item.key) })),
  }
}

type PremedRow = Record<string, unknown> & { id: string; phase: string; entry: string; ordinal: number; status: string }

/** A stand-in for the premedication order table. */
function premedDb() {
  const rows: PremedRow[] = []
  let next = 0
  const db = {
    preopPremedicationOrder: {
      findMany: vi.fn(async ({ where }: { where: { phase: string; status: string } }) => rows
        .filter(row => row.phase === where.phase && row.status === where.status)
        .sort((a, b) => a.ordinal - b.ordinal)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `p${next++}`, status: "ACTIVE" } as PremedRow
        rows.push(row)
        return row
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(rows.find(row => row.id === where.id)!, data)),
      updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        for (const row of rows) if (where.id.in.includes(row.id)) Object.assign(row, data)
        return { count: where.id.in.length }
      }),
    },
    conceptMap: { findFirst: vi.fn(async ({ where }: { where: { sourceCode: string } }) => where.sourceCode === "N05CD08" ? { standardConceptId: 708298 } : null) },
  } as unknown as Db
  const active = () => rows.filter(row => row.status === "ACTIVE")
  return { db, rows, active }
}

const premed = (db: Db, orders: Parameters<typeof savePremedicationOrders>[1]["orders"], config: PreopSectionConfig = defaultPreopSectionConfig("ADULT")) =>
  savePremedicationOrders(db, { caseId: "case-1", preopId: "preop-1", actorId: "dr-1", config, orders })

describe("a case's premedication orders", () => {
  it("orders each drug as a row of its own, read and coded from the picker's words", async () => {
    const { db, active } = premedDb()
    await premed(db, { DAY_BEFORE: "Midazolam 7.5 mg PO; Paracetamol 1000 mg PO", MORNING: "" })
    expect(active().map(row => [row.phase, row.entry, row.drug, row.atcCode, row.dose, row.unit, row.route, row.conceptId, row.ordinal])).toEqual([
      ["DAY_BEFORE", "Midazolam 7.5 mg PO", "Midazolam", "N05CD08", 7.5, "mg", "PO", 708298, 0],
      ["DAY_BEFORE", "Paracetamol 1000 mg PO", "Paracetamol", "N02BE01", 1000, "mg", "PO", null, 1],
    ])
    expect(serializePremedicationOrders(active())).toEqual({ DAY_BEFORE: "Midazolam 7.5 mg PO; Paracetamol 1000 mg PO", MORNING: "" })
  })

  it("keeps a drug still ordered, cancels one taken off, and leaves a phase not sent alone", async () => {
    const { db, rows, active } = premedDb()
    await premed(db, { DAY_BEFORE: "Midazolam 7.5 mg PO; Paracetamol 1000 mg PO", MORNING: "Pantoprazole 40 mg PO" })
    const midazolam = rows[0].id
    await premed(db, { DAY_BEFORE: "Paracetamol 1000 mg PO; Midazolam 7.5 mg PO; Diazepam 5 mg PO" })
    expect(rows.find(row => row.id === midazolam)!.status).toBe("ACTIVE")
    expect(serializePremedicationOrders(active())).toEqual({ DAY_BEFORE: "Paracetamol 1000 mg PO; Midazolam 7.5 mg PO; Diazepam 5 mg PO", MORNING: "Pantoprazole 40 mg PO" })
    await premed(db, { DAY_BEFORE: "Diazepam 5 mg PO", MORNING: null })
    expect(serializePremedicationOrders(active())).toEqual({ DAY_BEFORE: "Diazepam 5 mg PO", MORNING: "" })
    expect(rows.filter(row => row.status === "CANCELLED").map(row => row.entry).sort()).toEqual(["Midazolam 7.5 mg PO", "Pantoprazole 40 mg PO", "Paracetamol 1000 mg PO"])
  })

  it("does nothing without the orders or with the section off, and refuses what Core refuses", async () => {
    const { db, rows } = premedDb()
    await premed(db, undefined)
    const off = defaultPreopSectionConfig("ADULT")
    off.sections.PREMEDICATION = false
    await premed(db, { MORNING: "Midazolam 7.5 mg PO" }, off)
    expect(rows).toEqual([])
    await expect(premed(db, { NOON: "Midazolam 7.5 mg PO" } as never)).rejects.toMatchObject({ code: "PREOP_PREMEDICATION_REFUSED" })
  })
})

describe("a profile's section rows", () => {
  it("is current only with every section, bundled row and specialty", () => {
    expect(sectionRowsCurrent(rows(), ClinicalMode.ADULT)).toBe(true)
    // The paediatric profile also holds nil by mouth.
    expect(sectionRowsCurrent(rows("ADULT"), ClinicalMode.PEDIATRIC)).toBe(false)
    const missing = rows()
    missing.orderOptions.pop()
    expect(sectionRowsCurrent(missing, ClinicalMode.ADULT)).toBe(false)
  })

  it("reads bundled rows with Core's labels and a hospital's rows with their own", () => {
    const profile = rows()
    profile.orderOptions.push({ key: "CUSTOM_ECG", list: "WARD_ORDER", kind: "SIMPLE", labelEn: "ECG", labelBg: "ЕКГ", conceptId: 0, bundled: false, enabled: true, sortOrder: 99, hoursMode: "NONE", labTest: null })
    profile.orderOptions[1] = { ...profile.orderOptions[1]!, labelEn: "stale", enabled: false }
    const config = sectionConfigOf(profile, ClinicalMode.ADULT)
    expect(config.orderOptions.find(option => option.key === "CORRECT_ELECTROLYTES")).toMatchObject({ labelEn: "Correct electrolyte disturbances", enabled: false })
    expect(config.orderOptions.find(option => option.key === "CUSTOM_ECG")).toMatchObject({ labelBg: "ЕКГ", bundled: false })
  })

  it("turns medication instructions off with the medication list", () => {
    const profile = rows()
    profile.sections = profile.sections.map(row => row.sectionKey === "CURRENT_MEDICATIONS" ? { ...row, enabled: false } : row)
    expect(sectionConfigOf(profile, ClinicalMode.ADULT).sections.MEDICATION_INSTRUCTIONS).toBe(false)
  })
})

describe("an operator's change", () => {
  function profileDb() {
    const profile = { id: "p1", ...rows() }
    const db = {
      preopAssessmentProfile: { findUniqueOrThrow: vi.fn(async () => structuredClone(profile)) },
      preopProfileSection: {
        upsert: vi.fn(async ({ where, update }: { where: { profileId_sectionKey: { sectionKey: string } }; update: { enabled: boolean } }) => {
          profile.sections.find(row => row.sectionKey === where.profileId_sectionKey.sectionKey)!.enabled = update.enabled
        }),
      },
      preopProfileOrderOption: {
        deleteMany: vi.fn(async ({ where }: { where: { key: { notIn: string[] } } }) => {
          profile.orderOptions = profile.orderOptions.filter(row => row.bundled || where.key.notIn.includes(row.key))
        }),
        upsert: vi.fn(async ({ where, create, update }: { where: { profileId_key: { key: string } }; create: ProfileSectionRows["orderOptions"] extends (infer R)[] | undefined ? R : never; update: Record<string, unknown> }) => {
          const row = profile.orderOptions.find(item => item.key === where.profileId_key.key)
          if (row) Object.assign(row, update)
          else profile.orderOptions.push({ ...create })
        }),
      },
      preopProfileConsultSpecialty: {
        updateMany: vi.fn(async ({ where, data }: { where: { specialtyKey: { in?: string[]; notIn?: string[] } }; data: { enabled: boolean } }) => {
          for (const row of profile.consultSpecialties) {
            const hit = where.specialtyKey.in ? where.specialtyKey.in.includes(row.specialtyKey) : !where.specialtyKey.notIn!.includes(row.specialtyKey)
            if (hit) row.enabled = data.enabled
          }
        }),
      },
    } as unknown as Db
    return { db, profile }
  }
  const bundledList = () => BUNDLED_PREOP_ORDER_OPTIONS.map(option => ({ key: option.key, list: option.list, enabled: true }))

  it("switches sections and rows, adds and removes a hospital row, and sets the specialties", async () => {
    const { db, profile } = profileDb()
    const custom = { key: "CUSTOM_ECG", list: "WARD_ORDER" as const, enabled: true, labelEn: " ECG ", labelBg: "ЕКГ" }
    const { after } = await updateSectionRows(db, "p1", ClinicalMode.ADULT, {
      sections: { LABS: false },
      orderOptions: [custom, ...bundledList().map(option => option.key === "CORRECT_ANAEMIA" ? { ...option, enabled: false } : option)],
      consultSpecialtyKeys: ["1004", "1062"],
    })
    expect(after.sections.LABS).toBe(false)
    expect(after.orderOptions.find(option => option.key === "CUSTOM_ECG")).toMatchObject({ labelEn: "ECG", kind: "SIMPLE", sortOrder: 0 })
    expect(after.orderOptions.find(option => option.key === "CORRECT_ANAEMIA")!.enabled).toBe(false)
    expect(after.consultSpecialtyKeys).toEqual(["1004", "1062"])

    await updateSectionRows(db, "p1", ClinicalMode.ADULT, { sections: {}, orderOptions: bundledList(), consultSpecialtyKeys: ["1004"] })
    expect(profile.orderOptions.some(row => row.key === "CUSTOM_ECG")).toBe(false)
  })

  it("refuses to remove a bundled row, a nameless hospital row, an unknown section or specialty, and instructions without medications", async () => {
    const { db } = profileDb()
    const base = { sections: {}, orderOptions: bundledList(), consultSpecialtyKeys: [] as string[] }
    await expect(updateSectionRows(db, "p1", ClinicalMode.ADULT, { ...base, orderOptions: bundledList().slice(1) }))
      .rejects.toMatchObject({ code: "BUNDLED_ORDER_OPTION_CANNOT_BE_REMOVED" })
    await expect(updateSectionRows(db, "p1", ClinicalMode.ADULT, { ...base, orderOptions: [...bundledList(), { key: "CUSTOM_X", list: "WARD_ORDER", enabled: true, labelEn: "X", labelBg: " " }] }))
      .rejects.toMatchObject({ code: "ORDER_OPTION_LABELS_REQUIRED" })
    await expect(updateSectionRows(db, "p1", ClinicalMode.ADULT, { ...base, orderOptions: [...bundledList(), { key: "OTHER", list: "WARD_ORDER", enabled: true, labelEn: "X", labelBg: "X" }] }))
      .rejects.toMatchObject({ code: "UNKNOWN_ORDER_OPTION" })
    await expect(updateSectionRows(db, "p1", ClinicalMode.ADULT, { ...base, sections: { PEDIATRIC_FASTING: true } }))
      .rejects.toMatchObject({ code: "UNKNOWN_PREOP_SECTION" })
    await expect(updateSectionRows(db, "p1", ClinicalMode.ADULT, { ...base, sections: { PEDIATRIC_FASTING: false } })).resolves.toBeTruthy()
    await expect(updateSectionRows(db, "p1", ClinicalMode.ADULT, { ...base, sections: { NOT_A_SECTION: false } }))
      .rejects.toMatchObject({ code: "UNKNOWN_PREOP_SECTION" })
    await expect(updateSectionRows(db, "p1", ClinicalMode.ADULT, { ...base, consultSpecialtyKeys: ["9999"] }))
      .rejects.toMatchObject({ code: "UNKNOWN_SPECIALTY" })
    await expect(updateSectionRows(db, "p1", ClinicalMode.ADULT, { ...base, sections: { CURRENT_MEDICATIONS: false } }))
      .rejects.toMatchObject({ code: "MEDICATION_INSTRUCTIONS_NEED_CURRENT_MEDICATIONS" })
    await expect(updateSectionRows(db, "p1", ClinicalMode.ADULT, { ...base, sections: { CURRENT_MEDICATIONS: false, MEDICATION_INSTRUCTIONS: false } }))
      .resolves.toBeTruthy()
  })
})
