import { ClinicalMode, PreopOrderStatus, Prisma } from "@/generated/prisma/client"
import { DEFAULT_CONSULT_SPECIALTY_KEYS, NHIS_SPECIALTIES, NHIS_SPECIALTY_BY_KEY } from "@lospor/core/nhis-specialties"
import {
  BUNDLED_PREOP_ORDER_OPTIONS,
  CUSTOM_ORDER_KEY_PREFIX,
  MORNING_GLUCOSE_CONCEPT_ID,
  MORNING_GLUCOSE_LOINC,
  isCustomOrderKey,
  medicationInstructionProblems,
  preopSectionConfigFor,
  preopSectionDefinition,
  preopSectionsFor,
  wardOrderIdentity,
  wardOrderProblems,
  type PreopHoursMode,
  type PreopMedicationInstruction,
  type PreopMedicationInstructionInput,
  type PreopOrderKind,
  type PreopOrderList,
  type PreopOrderOption,
  type PreopSectionConfig,
  type PreopSectionKey,
  type PreopWardOrder,
  type PreopWardOrderInput,
} from "@lospor/core/preop-orders"
import {
  parsePremedicationEntries,
  premedicationEntries,
  premedicationOrderProblems,
  type PremedicationOrders,
  type PremedicationPhase,
} from "@lospor/core/premedication"

/**
 * A population's switchable sections and order rows, and a case's ward orders
 * and medication instructions (9.16.0).
 *
 * The hospital's choices are rows beside the profile's questions, provisioned
 * from Core the same way: missing rows are added on first use and after an
 * upgrade, and nothing an operator chose is changed. A case's orders keep their
 * own copy of what was ordered.
 */

type Db = Prisma.TransactionClient

export class PreopSectionsError extends Error {
  constructor(readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code)
  }
}

// ── Profile rows ──────────────────────────────────────────────────────────

export type ProfileSectionRows = {
  sections?: { sectionKey: string; enabled: boolean }[]
  orderOptions?: {
    key: string
    list: string
    kind: string
    labelEn: string
    labelBg: string
    conceptId: number
    bundled: boolean
    enabled: boolean
    sortOrder: number
    hoursMode: string
    labTest: string | null
  }[]
  consultSpecialties?: { specialtyKey: string; enabled: boolean }[]
}

export const PROFILE_SECTION_INCLUDE = {
  sections: true,
  orderOptions: { orderBy: { sortOrder: "asc" } },
  consultSpecialties: true,
} as const

/** Whether a profile holds every row Core ships. */
export function sectionRowsCurrent(profile: ProfileSectionRows, population: ClinicalMode): boolean {
  const sections = new Set(profile.sections?.map(row => row.sectionKey) ?? [])
  const options = new Set(profile.orderOptions?.map(row => row.key) ?? [])
  const specialties = new Set(profile.consultSpecialties?.map(row => row.specialtyKey) ?? [])
  return preopSectionsFor(population).every(section => sections.has(section.key))
    && BUNDLED_PREOP_ORDER_OPTIONS.every(option => options.has(option.key))
    && NHIS_SPECIALTIES.every(item => specialties.has(item.key))
}

/**
 * Adds the rows a profile is missing: each section on, each bundled row on and
 * after the hospital's own, each clinical doctor specialty on. Rows already
 * there are left as the operator set them.
 */
export async function provisionSectionRows(db: Db, profileId: string, population: ClinicalMode, fresh = false): Promise<void> {
  await db.preopProfileSection.createMany({
    data: preopSectionsFor(population).map(section => ({ profileId, sectionKey: section.key, enabled: true })),
    skipDuplicates: true,
  })
  // A profile just created has none: one round trip fewer.
  const present = fresh ? [] : await db.preopProfileOrderOption.findMany({ where: { profileId }, select: { key: true, list: true, sortOrder: true } })
  const presentKeys = new Set(present.map(row => row.key))
  const nextOrder = new Map<string, number>()
  for (const row of present) nextOrder.set(row.list, Math.max(nextOrder.get(row.list) ?? 0, row.sortOrder + 1))
  const added = BUNDLED_PREOP_ORDER_OPTIONS.filter(option => !presentKeys.has(option.key))
  if (added.length > 0) {
    await db.preopProfileOrderOption.createMany({
      data: added.map(option => {
        // A fresh profile takes Core's order; an upgrade puts new rows last.
        const sortOrder = present.length === 0 ? option.sortOrder : nextOrder.get(option.list) ?? 0
        if (present.length > 0) nextOrder.set(option.list, sortOrder + 1)
        return {
          profileId,
          key: option.key,
          list: option.list,
          kind: option.kind,
          labelEn: option.labelEn,
          labelBg: option.labelBg,
          conceptId: option.conceptId,
          bundled: true,
          enabled: true,
          sortOrder,
          hoursMode: option.hoursMode,
          labTest: option.labTest,
        }
      }),
      skipDuplicates: true,
    })
  }
  const defaults = new Set(DEFAULT_CONSULT_SPECIALTY_KEYS)
  await db.preopProfileConsultSpecialty.createMany({
    data: NHIS_SPECIALTIES.map(item => ({ profileId, specialtyKey: item.key, enabled: defaults.has(item.key) })),
    skipDuplicates: true,
  })
}

/**
 * The configuration as Core reads it. Bundled rows take Core's current labels
 * and concept: they are software, like the questions, and a release that
 * corrects one corrects it everywhere.
 */
export function sectionConfigOf(profile: ProfileSectionRows, population: ClinicalMode): PreopSectionConfig {
  const sections = {} as Record<PreopSectionKey, boolean>
  const stored = new Map(profile.sections?.map(row => [row.sectionKey, row.enabled]) ?? [])
  for (const section of preopSectionsFor(population)) sections[section.key] = stored.get(section.key) ?? true
  const orderOptions: PreopOrderOption[] = (profile.orderOptions ?? []).map(row => {
    const bundled = BUNDLED_PREOP_ORDER_OPTIONS.find(option => option.key === row.key)
    return bundled
      ? { ...bundled, enabled: row.enabled, sortOrder: row.sortOrder }
      : {
          key: row.key,
          list: row.list as PreopOrderList,
          kind: row.kind as PreopOrderKind,
          labelEn: row.labelEn,
          labelBg: row.labelBg,
          conceptId: row.conceptId,
          bundled: false,
          enabled: row.enabled,
          sortOrder: row.sortOrder,
          hoursMode: row.hoursMode as PreopHoursMode,
          labTest: row.labTest,
        }
  })
  // A profile read before its rows exist reads as the bundled defaults.
  const present = new Set(orderOptions.map(option => option.key))
  for (const option of BUNDLED_PREOP_ORDER_OPTIONS) if (!present.has(option.key)) orderOptions.push({ ...option })
  orderOptions.sort((a, b) => a.list.localeCompare(b.list) || a.sortOrder - b.sortOrder)
  const specialties = profile.consultSpecialties?.length
    ? profile.consultSpecialties.filter(row => row.enabled).map(row => row.specialtyKey)
    : [...DEFAULT_CONSULT_SPECIALTY_KEYS]
  const order = new Map(NHIS_SPECIALTIES.map((item, index) => [item.key, index]))
  specialties.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  return preopSectionConfigFor({ [population]: { sections, orderOptions, consultSpecialtyKeys: specialties } }, population)
}

// ── An operator's change ──────────────────────────────────────────────────

export type SectionConfigInput = {
  sections: Partial<Record<string, boolean>>
  /** Every row to keep, in each list's order. A hospital row left out is removed. */
  orderOptions: {
    key: string
    list: PreopOrderList
    enabled: boolean
    /** A hospital row's own text and shape; ignored for a bundled row. */
    labelEn?: string
    labelBg?: string
    hoursMode?: PreopHoursMode
  }[]
  consultSpecialtyKeys: string[]
}

const MAX_LABEL = 200

/**
 * Applies an operator's change to one population's sections, rows and
 * specialties, in place, and says what changed. The caller audits it.
 */
export async function updateSectionRows(
  db: Db,
  profileId: string,
  population: ClinicalMode,
  input: SectionConfigInput,
): Promise<{ before: PreopSectionConfig; after: PreopSectionConfig }> {
  const profile = await db.preopAssessmentProfile.findUniqueOrThrow({ where: { id: profileId }, include: PROFILE_SECTION_INCLUDE })
  const before = sectionConfigOf(profile, population)

  // A whole configuration names every section; one this population does not
  // have can only be off, and is not stored.
  const allowed = new Set(preopSectionsFor(population).map(section => section.key as string))
  const sectionInput: Record<string, boolean> = {}
  for (const [key, enabled] of Object.entries(input.sections)) {
    if (enabled === undefined) continue
    if (allowed.has(key)) sectionInput[key] = enabled
    else if (!preopSectionDefinition(key) || enabled) throw new PreopSectionsError("UNKNOWN_PREOP_SECTION", { sectionKey: key, population })
  }
  const on = (key: PreopSectionKey) => sectionInput[key] ?? before.sections[key]
  if (on("MEDICATION_INSTRUCTIONS") && !on("CURRENT_MEDICATIONS")) {
    throw new PreopSectionsError("MEDICATION_INSTRUCTIONS_NEED_CURRENT_MEDICATIONS")
  }

  const seen = new Set<string>()
  for (const option of input.orderOptions) {
    if (seen.has(option.key)) throw new PreopSectionsError("DUPLICATE_ORDER_OPTION", { key: option.key })
    seen.add(option.key)
    const bundled = BUNDLED_PREOP_ORDER_OPTIONS.find(item => item.key === option.key)
    if (bundled) {
      if (bundled.list !== option.list) throw new PreopSectionsError("ORDER_OPTION_WRONG_LIST", { key: option.key })
      continue
    }
    if (!isCustomOrderKey(option.key) || !/^CUSTOM_[A-Z0-9_]{1,60}$/.test(option.key)) {
      throw new PreopSectionsError("UNKNOWN_ORDER_OPTION", { key: option.key })
    }
    const labelEn = option.labelEn?.trim() ?? ""
    const labelBg = option.labelBg?.trim() ?? ""
    if (!labelEn || !labelBg || labelEn.length > MAX_LABEL || labelBg.length > MAX_LABEL) {
      throw new PreopSectionsError("ORDER_OPTION_LABELS_REQUIRED", { key: option.key })
    }
  }
  for (const option of BUNDLED_PREOP_ORDER_OPTIONS) {
    if (!seen.has(option.key)) throw new PreopSectionsError("BUNDLED_ORDER_OPTION_CANNOT_BE_REMOVED", { key: option.key })
  }
  for (const key of input.consultSpecialtyKeys) {
    if (!NHIS_SPECIALTY_BY_KEY.has(key)) throw new PreopSectionsError("UNKNOWN_SPECIALTY", { specialtyKey: key })
  }

  for (const [sectionKey, enabled] of Object.entries(sectionInput)) {
    await db.preopProfileSection.upsert({
      where: { profileId_sectionKey: { profileId, sectionKey } },
      create: { profileId, sectionKey, enabled },
      update: { enabled },
    })
  }

  // Each list keeps the order it was sent in.
  const sortOrder = new Map<string, number>()
  const counters = new Map<string, number>()
  for (const option of input.orderOptions) {
    const next = counters.get(option.list) ?? 0
    sortOrder.set(option.key, next)
    counters.set(option.list, next + 1)
  }
  const keep = input.orderOptions.map(option => option.key)
  await db.preopProfileOrderOption.deleteMany({ where: { profileId, bundled: false, key: { notIn: keep } } })
  for (const option of input.orderOptions) {
    const bundled = BUNDLED_PREOP_ORDER_OPTIONS.find(item => item.key === option.key)
    const shape = bundled
      ? { list: bundled.list, kind: bundled.kind, labelEn: bundled.labelEn, labelBg: bundled.labelBg, conceptId: bundled.conceptId, bundled: true, hoursMode: bundled.hoursMode, labTest: bundled.labTest }
      : {
          list: option.list,
          // A hospital's ward order needs nothing more than its tick; its
          // medication row picks a drug, and hours if the operator says so.
          kind: option.list === "WARD_ORDER" ? "SIMPLE" : "MEDICATION",
          labelEn: option.labelEn!.trim(),
          labelBg: option.labelBg!.trim(),
          conceptId: 0,
          bundled: false,
          hoursMode: option.list === "WARD_ORDER" ? "NONE" : option.hoursMode ?? "OPTIONAL",
          labTest: null,
        }
    await db.preopProfileOrderOption.upsert({
      where: { profileId_key: { profileId, key: option.key } },
      create: { profileId, key: option.key, ...shape, enabled: option.enabled, sortOrder: sortOrder.get(option.key)! },
      update: { ...shape, enabled: option.enabled, sortOrder: sortOrder.get(option.key)! },
    })
  }

  const wanted = new Set(input.consultSpecialtyKeys)
  await db.preopProfileConsultSpecialty.updateMany({ where: { profileId, specialtyKey: { in: [...wanted] } }, data: { enabled: true } })
  await db.preopProfileConsultSpecialty.updateMany({ where: { profileId, specialtyKey: { notIn: [...wanted] } }, data: { enabled: false } })

  const updated = await db.preopAssessmentProfile.findUniqueOrThrow({ where: { id: profileId }, include: PROFILE_SECTION_INCLUDE })
  return { before, after: sectionConfigOf(updated, population) }
}

/** A fresh key for a hospital's own row. */
export function newCustomOrderKey(random: () => string): string {
  return `${CUSTOM_ORDER_KEY_PREFIX}${random().replace(/[^A-Za-z0-9]/g, "").slice(0, 24).toUpperCase()}`
}

// ── A case's orders ───────────────────────────────────────────────────────

type StoredWardOrder = Awaited<ReturnType<Db["preopWardOrder"]["findMany"]>>[number]
type StoredInstruction = Awaited<ReturnType<Db["preopMedicationInstruction"]["findMany"]>>[number]
type StoredPremedication = Pick<Awaited<ReturnType<Db["preopPremedicationOrder"]["findMany"]>>[number], "phase" | "entry" | "ordinal">

/** A case's active premedication orders as the form holds them: each phase's entries in order. */
export function serializePremedicationOrders(rows: StoredPremedication[]): Record<PremedicationPhase, string> {
  const text = (phase: PremedicationPhase) => rows
    .filter(row => row.phase === phase)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(row => row.entry)
    .join("; ")
  return { DAY_BEFORE: text("DAY_BEFORE"), MORNING: text("MORNING") }
}

export function serializeWardOrder(row: StoredWardOrder): PreopWardOrder {
  return {
    id: row.id,
    optionKey: row.optionKey,
    kind: row.kind as PreopOrderKind,
    labelEn: row.labelEn,
    labelBg: row.labelBg,
    conceptId: row.conceptId,
    specialtyKey: row.specialtyKey,
    specialtyLabelEn: row.specialtyLabelEn,
    specialtyLabelBg: row.specialtyLabelBg,
    labTest: row.labTest,
    labLoinc: row.labLoinc,
  }
}

export function serializeMedicationInstruction(row: StoredInstruction): PreopMedicationInstruction {
  return {
    id: row.clientId,
    optionKey: row.optionKey,
    labelEn: row.labelEn,
    labelBg: row.labelBg,
    conceptId: row.conceptId,
    medicationLabel: row.medicationLabel,
    medicationInn: row.medicationInn,
    medicationAtc: row.medicationAtc,
    hoursBefore: row.hoursBefore,
  }
}

async function labCoding(db: Db, labTest: string, optionKey: string): Promise<{ labLoinc: string | null; labConceptId: number | null }> {
  // The morning glucose is serum glucose, whatever code the library's glucose carries.
  if (optionKey === "MORNING_SERUM_GLUCOSE") return { labLoinc: MORNING_GLUCOSE_LOINC, labConceptId: MORNING_GLUCOSE_CONCEPT_ID }
  const loinc = await db.labLoinc.findUnique({ where: { name: labTest }, select: { loincCode: true } })
  if (!loinc) return { labLoinc: null, labConceptId: null }
  const mapped = await db.conceptMap.findFirst({
    where: { active: true, domain: "measurement", sourceVocabulary: "LOINC", sourceCode: loinc.loincCode, mappingStatus: { not: "REJECTED" } },
    select: { standardConceptId: true },
  })
  return { labLoinc: loinc.loincCode, labConceptId: mapped?.standardConceptId ?? null }
}

/**
 * A case's ward orders, as the form now holds them. An order no longer held is
 * cancelled; one held again is placed again as a new row, so the record shows
 * both. Undefined leaves the case's orders as they are, as does a section the
 * hospital has switched off.
 */
export async function saveWardOrders(
  db: Db,
  args: { caseId: string; preopId: string; actorId: string; population: ClinicalMode; config: PreopSectionConfig; orders: PreopWardOrderInput[] | undefined },
): Promise<void> {
  if (args.orders === undefined || !args.config.sections.WARD_ORDERS) return
  const existing = await db.preopWardOrder.findMany({ where: { preopId: args.preopId, status: PreopOrderStatus.ACTIVE } })
  const held = new Map(existing.map(row => [wardOrderIdentity(row), row]))
  const problems = wardOrderProblems(args.orders, args.config, new Set(held.keys()))
  if (problems.length > 0) throw new PreopSectionsError("PREOP_WARD_ORDERS_REFUSED", { problems })

  const wanted = new Map(args.orders.map(order => [wardOrderIdentity(order), order]))
  const now = new Date()
  const cancelled = existing.filter(row => !wanted.has(wardOrderIdentity(row))).map(row => row.id)
  if (cancelled.length > 0) {
    await db.preopWardOrder.updateMany({ where: { id: { in: cancelled } }, data: { status: PreopOrderStatus.CANCELLED, cancelledAt: now } })
  }
  const options = new Map(args.config.orderOptions.map(option => [option.key, option]))
  for (const [identity, order] of wanted) {
    if (held.has(identity)) continue
    const option = options.get(order.optionKey)!
    const specialty = option.kind === "CONSULT" && order.specialtyKey ? NHIS_SPECIALTY_BY_KEY.get(order.specialtyKey) ?? null : null
    const labTest = option.kind === "LAB" ? option.labTest ?? order.labTest ?? null : null
    const coding = labTest ? await labCoding(db, labTest, option.key) : { labLoinc: null, labConceptId: null }
    await db.preopWardOrder.create({
      data: {
        preopId: args.preopId,
        caseId: args.caseId,
        optionKey: option.key,
        kind: option.kind,
        labelEn: option.labelEn,
        labelBg: option.labelBg,
        conceptId: option.conceptId,
        specialtyKey: specialty?.key ?? null,
        specialtyLabelEn: specialty?.labelEn ?? null,
        specialtyLabelBg: specialty?.labelBg ?? null,
        labTest,
        ...coding,
        authorId: args.actorId,
      },
    })
  }
}

/**
 * A case's medication instructions, as the form now holds them, matched by the
 * form's own id. A changed row is updated in place; a row no longer held is
 * cancelled. Undefined, or a section switched off, leaves them as they are.
 */
export async function saveMedicationInstructions(
  db: Db,
  args: { caseId: string; preopId: string; actorId: string; config: PreopSectionConfig; instructions: PreopMedicationInstructionInput[] | undefined },
): Promise<void> {
  if (args.instructions === undefined || !args.config.sections.MEDICATION_INSTRUCTIONS) return
  const existing = await db.preopMedicationInstruction.findMany({ where: { preopId: args.preopId } })
  const byClientId = new Map(existing.map(row => [row.clientId, row]))
  const held = new Set(existing.filter(row => row.status === PreopOrderStatus.ACTIVE).map(row => row.clientId))
  const problems = medicationInstructionProblems(args.instructions, args.config, held)
  if (problems.length > 0) throw new PreopSectionsError("PREOP_MEDICATION_INSTRUCTIONS_REFUSED", { problems })

  const now = new Date()
  const wanted = new Set(args.instructions.map(row => row.id))
  const cancelled = existing.filter(row => row.status === PreopOrderStatus.ACTIVE && !wanted.has(row.clientId)).map(row => row.id)
  if (cancelled.length > 0) {
    await db.preopMedicationInstruction.updateMany({ where: { id: { in: cancelled } }, data: { status: PreopOrderStatus.CANCELLED, cancelledAt: now } })
  }
  const options = new Map(args.config.orderOptions.map(option => [option.key, option]))
  for (const instruction of args.instructions) {
    const option = options.get(instruction.optionKey)!
    const data = {
      optionKey: option.key,
      labelEn: option.labelEn,
      labelBg: option.labelBg,
      conceptId: option.conceptId,
      medicationLabel: instruction.medicationLabel.trim(),
      medicationInn: instruction.medicationInn?.trim() || null,
      medicationAtc: instruction.medicationAtc?.trim() || null,
      hoursBefore: instruction.hoursBefore ?? null,
    }
    const stored = byClientId.get(instruction.id)
    if (!stored) {
      await db.preopMedicationInstruction.create({
        data: { ...data, preopId: args.preopId, caseId: args.caseId, clientId: instruction.id, authorId: args.actorId },
      })
      continue
    }
    const same = stored.status === PreopOrderStatus.ACTIVE
      && stored.optionKey === data.optionKey
      && stored.medicationLabel === data.medicationLabel
      && stored.medicationInn === data.medicationInn
      && stored.medicationAtc === data.medicationAtc
      && stored.hoursBefore === data.hoursBefore
    if (same) continue
    await db.preopMedicationInstruction.update({
      where: { id: stored.id },
      // A row's labels stay those it was first given unless its row changed.
      data: {
        ...(stored.optionKey === data.optionKey ? { ...data, labelEn: stored.labelEn, labelBg: stored.labelBg, conceptId: stored.conceptId } : data),
        status: PreopOrderStatus.ACTIVE,
        cancelledAt: null,
        authorId: args.actorId,
      },
    })
  }
}

/**
 * A case's premedication orders, as the form now holds them, phase by phase.
 * An entry still held keeps its row (and when it was ordered); one no longer
 * held is cancelled; a new one is ordered, its drug read out of the entry and
 * coded through its ATC code as an intraoperative dose is. A phase left out
 * leaves its orders as they are, as does the section switched off.
 */
export async function savePremedicationOrders(
  db: Db,
  args: { caseId: string; preopId: string; actorId: string; config: PreopSectionConfig; orders: PremedicationOrders | undefined },
): Promise<void> {
  if (args.orders === undefined || !args.config.sections.PREMEDICATION) return
  const problems = premedicationOrderProblems(args.orders)
  if (problems.length > 0) throw new PreopSectionsError("PREOP_PREMEDICATION_REFUSED", { problems })
  const now = new Date()
  for (const phase of ["DAY_BEFORE", "MORNING"] as const) {
    if (!(phase in args.orders)) continue
    const wanted = premedicationEntries(args.orders[phase])
    const existing = await db.preopPremedicationOrder.findMany({
      where: { preopId: args.preopId, phase, status: PreopOrderStatus.ACTIVE },
      orderBy: { ordinal: "asc" },
    })
    const unmatched = [...existing]
    const items = parsePremedicationEntries(wanted.join("; "), phase)
    for (const [ordinal, item] of items.entries()) {
      const index = unmatched.findIndex(row => row.entry === item.entry)
      if (index >= 0) {
        const [kept] = unmatched.splice(index, 1)
        if (kept.ordinal !== ordinal) await db.preopPremedicationOrder.update({ where: { id: kept.id }, data: { ordinal } })
        continue
      }
      await db.preopPremedicationOrder.create({
        data: {
          preopId: args.preopId,
          caseId: args.caseId,
          phase,
          entry: item.entry,
          drug: item.drug,
          atcCode: item.atcCode,
          dose: item.dose,
          unit: item.unit,
          route: item.route,
          conceptId: item.atcCode ? await drugConceptOf(db, item.atcCode) : null,
          ordinal,
          authorId: args.actorId,
        },
      })
    }
    if (unmatched.length > 0) {
      await db.preopPremedicationOrder.updateMany({
        where: { id: { in: unmatched.map(row => row.id) } },
        data: { status: PreopOrderStatus.CANCELLED, cancelledAt: now },
      })
    }
  }
}

async function drugConceptOf(db: Db, atcCode: string): Promise<number | null> {
  const mapped = await db.conceptMap.findFirst({
    where: { active: true, domain: "drug", sourceVocabulary: "ATC", sourceCode: atcCode, mappingStatus: { not: "REJECTED" } },
    select: { standardConceptId: true },
  })
  return mapped?.standardConceptId ?? null
}
