import { z } from "zod"
import { canonicalConcentrationUnit } from "@lospor/core/clinical-rule-vocabulary"
import { isBloodProductFluid } from "@lospor/core/intraop-fluids"
import { INTRAOP_VITAL_RULES } from "@lospor/core/intraop-vitals"
import { TCI_DRUG_SPECS, TCI_MODEL_DRUG, TCI_MODELS, TCI_SITES } from "@lospor/core/tci"
import { DEFIBRILLATION_MAX_J, DEFIBRILLATION_MIN_J } from "@lospor/core/defibrillation"
import { VITAL_COMPLICATION_KINDS } from "@lospor/core/vital-questions"
import { JET_VENTILATION } from "@lospor/core/gas-ranges"
import { CONTEXT_LINK_IDS } from "@lospor/core/intraop-suggestions"

const CONTEXT_LINK_AUTOMATION_IDS = new Set<string>(Object.values(CONTEXT_LINK_IDS))

/**
 * What a prompt_answer answers: a vitals question (10.1.0), or a suggestion
 * (10.2.0) -- a card, a hidden card row revealed, a reverse, readings or lab
 * question, a reminder or a follow-up.
 */
const answerKind = z.string().min(1).max(120).refine(
  value => (VITAL_COMPLICATION_KINDS as readonly string[]).includes(value)
    || value === "card"
    || value === "succession"
    || CONTEXT_LINK_AUTOMATION_IDS.has(value)
    || /^(card-reveal|reverse|reading|lab|reminder|timer|monitor):[A-Za-z0-9_-]+$/.test(value),
  "Unknown question",
)

const numericValue = z.number().finite()
const doseValue = z.union([z.string().max(80), numericValue])
const concentrationUnit = z.string().max(40).transform((value, context) => {
  const canonical = canonicalConcentrationUnit(value)
  if (!canonical) {
    context.addIssue({ code: "custom", message: "Unknown concentration unit" })
    return z.NEVER
  }
  return canonical.kind
})
const calculationBasis = z.enum([
  "FLAT",
  "NONE",
  "TBW",
  "TBW_KG",
  "IBW",
  "BSA_M2",
]).transform(value => value === "TBW_KG" ? "TBW" as const : value)
const fluidMillilitres = numericValue.nonnegative().max(1_000_000)

function positiveRate(value: unknown): boolean {
  if (value == null || value === "") return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
}

/**
 * Canonical HTTP boundary for intraoperative events.
 *
 * The object remains passthrough-compatible because older timetable event
 * kinds carry additional projection fields. Drug route-profile audit fields
 * are explicit so malformed provenance cannot be silently persisted.
 */
/** One bounded, optional number per charted vital, from the shared rules. */
function vitalFields(): Record<string, z.ZodTypeAny> {
  const fields: Record<string, z.ZodTypeAny> = {}
  for (const [name, rule] of Object.entries(INTRAOP_VITAL_RULES)) {
    let base = rule.integer ? z.number().int() : z.number()
    if (rule.min != null) base = base.min(rule.min)
    if (rule.max != null) base = base.max(rule.max)
    fields[name] = z.preprocess(
      // A cleared field arrives as "" or null and means "not recorded",
      // which is not a value to validate.
      value => (value === "" || value === null ? undefined : value),
      base.optional(),
    )
  }
  return fields
}

export const caseEventSchema = z.object({
  id: z.string().max(200).optional(),
  ts: z.string().optional(),
  type: z.string().min(1).max(64),
  name: z.string().max(200).optional(),
  label: z.string().max(200).optional(),
  dose: doseValue.optional(),
  unit: z.string().max(40).optional(),
  rate: doseValue.optional(),
  volume: doseValue.optional(),
  category: z.string().max(80).optional(),
  fluidId: z.string().min(1).max(200).optional(),
  fluidEntryMode: z.enum(["VOLUME", "RATE"]).optional(),
  bagVolumeMl: fluidMillilitres.optional(),
  administeredVolumeMl: fluidMillilitres.optional(),
  drugRoute: z.string().max(40).optional(),
  concentration: z.string().max(80).optional(),
  concentrationValue: numericValue.nonnegative().optional(),
  concentrationUnit: concentrationUnit.optional(),
  formulation: z.enum(["HYPOBARIC", "ISOBARIC", "HYPERBARIC"]).optional(),
  calculationBasis: calculationBasis.optional(),
  calculationWeightKg: numericValue.positive().optional(),
  // An infusion's pump rate beside its dose rate (2026-10-18). Bounded: a
  // pump does not run a litre an hour of a drug syringe.
  volumeRateMlPerHour: numericValue.nonnegative().max(1000).optional(),
  // A target-controlled infusion (2026-10-18): the model and site on the
  // start, the target in rate/unit, the pump's own total on the stop.
  tciModel: z.enum(TCI_MODELS).optional(),
  tciSite: z.enum(TCI_SITES).optional(),
  tciOpioids: z.boolean().optional(),
  pumpTotal: numericValue.nonnegative().max(100_000).optional(),
  pumpTotalUnit: z.enum(["mL", "mg", "mcg"]).optional(),
  calculationMethod: z.string().min(1).max(80).optional(),
  clinicalRuleKey: z.string().min(1).max(240).optional(),
  clinicalRuleVersion: z.string().min(1).max(160).optional(),
  clinicalRuleSourceIds: z.array(z.string().min(1).max(240)).max(64).optional(),
  clinicalPresetId: z.string().min(1).max(240).optional(),
  clinicalPresetVersion: z.number().int().positive().optional(),
  clinicalPresetScope: z.enum(["PLATFORM", "INSTITUTION", "USER"]).optional(),
  // When the clinician entered the event, beside when it happened (9.13.0).
  // A stop dated ahead of its entry is asked about when its time comes, and
  // confirmed with stopConfirmed. Validated rather than passed through: an
  // entry time that is not an instant would make that question unanswerable.
  recordedAt: z.string().datetime({ offset: true }).optional(),
  stopConfirmed: z.boolean().optional(),
  // Every charted vital, bounded. Without these they arrived through
  // passthrough below and were coerced with a bare Number(), so the API stored
  // whatever a client sent -- a BIS of -500, a train-of-four of 20 -- with the
  // only check living in a control the server does not run. Out of range is
  // refused rather than clamped: a clamped reading is an invented one.
  ...vitalFields(),
  // 10.1.0: a complication (timed; an episode has its end), a shock, and a
  // prompt answer. Ordinary prompts use "not_now"; succession and contextual
  // suggestions use the definitive "dismissed" answer.
  endTs: z.string().datetime({ offset: true }).optional(),
  complicationSource: z.enum(["timeline", "vitals", "readings", "suggestion"]).optional(),
  triggerReadingId: z.string().min(1).max(200).optional(),
  energyJ: z.number().int().min(DEFIBRILLATION_MIN_J).max(DEFIBRILLATION_MAX_J).optional(),
  synchronized: z.boolean().optional(),
  // 10.2.0: a time reconstructed afterwards (a dose given during an arrest, charted later).
  timeApproximate: z.boolean().optional(),
  answerFor: z.string().min(1).max(200).optional(),
  answerKind: answerKind.optional(),
  answer: z.enum(["not_now", "dismissed", "done"]).optional(),
  // 10.2.0: the suggestion an entry was made from (exported as a flag), a
  // tourniquet's site, and jet ventilation settings.
  suggestion: z.string().min(1).max(240).optional(),
  // Automation relation and structured-record linkage are optional metadata;
  // old events remain valid and readable without them.
  clinicalRelation: z.string().min(1).max(80).optional(),
  sourceEventId: z.string().min(1).max(200).optional(),
  // Structured airway/vascular writes can travel with their clinical event so
  // the API can apply both under the same case lock. The event id remains the
  // idempotency key for the whole operation.
  intraopPatch: z.record(z.string(), z.unknown()).optional(),
  site: z.string().min(1).max(40).optional(),
  jetPressureBar: numericValue.min(JET_VENTILATION.pressure.min).max(JET_VENTILATION.pressure.typedMax).optional(),
  jetRate: z.number().int().min(JET_VENTILATION.rate.min).max(JET_VENTILATION.rate.typedMax).optional(),
}).passthrough().superRefine((event, context) => {
  // TCI: the model belongs to the start; its target is in the model's unit and
  // within twice the screens' range (a typo, not a dose, beyond that).
  if (event.tciModel || event.tciSite || event.tciOpioids != null) {
    if (event.type !== "infusion_start") {
      context.addIssue({ code: "custom", path: ["tciModel"], message: "A TCI model is set when the infusion starts" })
    } else if (!event.tciModel || !event.tciSite) {
      context.addIssue({ code: "custom", path: ["tciModel"], message: "A TCI infusion needs both its model and its site" })
    } else {
      const spec = TCI_DRUG_SPECS[TCI_MODEL_DRUG[event.tciModel]]
      if (event.unit !== spec.units.target) {
        context.addIssue({ code: "custom", path: ["unit"], message: `A ${event.tciModel} target is in ${spec.units.target}` })
      }
      const target = Number(event.rate)
      if (!Number.isFinite(target) || target <= 0 || target > spec.target.max * 2) {
        context.addIssue({ code: "custom", path: ["rate"], message: `TCI target must be above 0 and at most ${spec.target.max * 2} ${spec.units.target}` })
      }
    }
  }
  if (event.type === "complication") {
    if (!event.label?.trim()) context.addIssue({ code: "custom", path: ["label"], message: "A complication needs its name" })
    if (event.endTs && event.ts && Date.parse(event.endTs) < Date.parse(event.ts)) {
      context.addIssue({ code: "custom", path: ["endTs"], message: "A complication cannot end before it starts" })
    }
  } else if (event.endTs || event.complicationSource || event.triggerReadingId) {
    context.addIssue({ code: "custom", path: ["endTs"], message: "Only a complication has an end or a source" })
  }
  if (event.type === "defibrillation") {
    if (event.energyJ == null) context.addIssue({ code: "custom", path: ["energyJ"], message: "A shock needs its energy" })
    if (event.synchronized == null) context.addIssue({ code: "custom", path: ["synchronized"], message: "A shock is synchronised or not" })
  } else if (event.energyJ != null || event.synchronized != null) {
    context.addIssue({ code: "custom", path: ["energyJ"], message: "Only a shock has an energy" })
  }
  if (event.type === "prompt_answer") {
    // A revealed card row records only what it revealed; every other answer is
    // an ordinary Not now/Done or a definitive succession/context dismissal.
    const reveal = event.answerKind?.startsWith("card-reveal:")
    if (!event.answerFor || !event.answerKind || (!reveal && !event.answer)) {
      context.addIssue({ code: "custom", path: ["answer"], message: "A prompt answer names its reading and its question" })
    }
    if (event.answer === "dismissed"
      && event.answerKind !== "succession"
      && !CONTEXT_LINK_AUTOMATION_IDS.has(event.answerKind ?? "")) {
      context.addIssue({
        code: "custom",
        path: ["answer"],
        message: "Only a succession or context prompt may be dismissed definitively",
      })
    }
  } else if (event.answerFor || event.answerKind || event.answer) {
    context.addIssue({ code: "custom", path: ["answer"], message: "Only a prompt answer answers a question" })
  }
  if (event.type === "jet_start" && (event.jetPressureBar == null || event.jetRate == null)) {
    context.addIssue({ code: "custom", path: ["jetPressureBar"], message: "Jet ventilation starts with its pressure and rate" })
  }
  if ((event.jetPressureBar != null || event.jetRate != null) && event.type !== "jet_start" && event.type !== "jet_change") {
    context.addIssue({ code: "custom", path: ["jetPressureBar"], message: "Only jet ventilation has a driving pressure and rate" })
  }
  if (event.site && !(event.type === "clinical_event" && (event.label === "Tourniquet on" || event.label === "Tourniquet off"))) {
    context.addIssue({ code: "custom", path: ["site"], message: "Only a tourniquet has a site" })
  }
  if ((event.pumpTotal != null || event.pumpTotalUnit) && event.type !== "infusion_stop") {
    context.addIssue({ code: "custom", path: ["pumpTotal"], message: "A pump total is entered on the stop" })
  }
  if ((event.pumpTotal != null) !== (event.pumpTotalUnit != null)) {
    context.addIssue({ code: "custom", path: ["pumpTotalUnit"], message: "A pump total needs its unit" })
  }
  const isFluidRate = event.type === "fluid_rate"
  const isRateStart = event.type === "fluid_start" && event.fluidEntryMode === "RATE"
  if (isFluidRate || isRateStart) {
    if (!event.fluidId) {
      context.addIssue({ code: "custom", path: ["fluidId"], message: "Fluid rate events require fluidId" })
    }
    if (!positiveRate(event.rate)) {
      context.addIssue({ code: "custom", path: ["rate"], message: "Fluid rate must be greater than zero" })
    }
    if (event.unit !== "mL/h") {
      context.addIssue({ code: "custom", path: ["unit"], message: "Fluid rate unit must be mL/h" })
    }
  }
  if (isRateStart) {
    if (!event.name?.trim()) {
      context.addIssue({ code: "custom", path: ["name"], message: "Fluid rate starts require a fluid name" })
    }
    if (!event.category?.trim()) {
      context.addIssue({ code: "custom", path: ["category"], message: "Fluid rate starts require a fluid category" })
    }
  }
  if (
    event.fluidEntryMode === "RATE"
    && isBloodProductFluid({ name: event.name, category: event.category })
  ) {
    context.addIssue({
      code: "custom",
      path: ["fluidEntryMode"],
      message: "Blood products support volume entry only",
    })
  }
})

/** New event writes require a real clinical instant; legacy snapshot parsing stays permissive. */
export const caseEventWriteSchema = caseEventSchema.and(z.object({
  ts: z.string().datetime({ offset: true }),
}))

export type CaseEventInput = z.infer<typeof caseEventSchema>

export function formatCanonicalConcentration(
  value: number | null | undefined,
  unit: string | null | undefined,
): string | null {
  if (value == null || !Number.isFinite(value)) return null
  const canonical = unit ? canonicalConcentrationUnit(unit) : null
  if (!canonical) return String(value)
  return canonical.kind === "PERCENT"
    ? `${value}${canonical.display}`
    : `${value} ${canonical.display}`
}
