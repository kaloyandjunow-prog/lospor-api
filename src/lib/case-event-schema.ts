import { z } from "zod"
import { canonicalConcentrationUnit } from "@lospor/core/clinical-rule-vocabulary"
import { isBloodProductFluid } from "@lospor/core/intraop-fluids"
import { INTRAOP_VITAL_RULES } from "@lospor/core/intraop-vitals"

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
    const base = rule.integer ? z.number().int() : z.number()
    fields[name] = z.preprocess(
      // A cleared field arrives as "" or null and means "not recorded",
      // which is not a value to validate.
      value => (value === "" || value === null ? undefined : value),
      base.min(rule.min).max(rule.max).optional(),
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
  calculationMethod: z.string().min(1).max(80).optional(),
  clinicalRuleKey: z.string().min(1).max(240).optional(),
  clinicalRuleVersion: z.string().min(1).max(160).optional(),
  clinicalRuleSourceIds: z.array(z.string().min(1).max(240)).max(64).optional(),
  clinicalPresetId: z.string().min(1).max(240).optional(),
  clinicalPresetVersion: z.number().int().positive().optional(),
  clinicalPresetScope: z.enum(["PLATFORM", "INSTITUTION", "USER"]).optional(),
  // Every charted vital, bounded. Without these they arrived through
  // passthrough below and were coerced with a bare Number(), so the API stored
  // whatever a client sent -- a BIS of -500, a train-of-four of 20 -- with the
  // only check living in a control the server does not run. Out of range is
  // refused rather than clamped: a clamped reading is an invented one.
  ...vitalFields(),
}).passthrough().superRefine((event, context) => {
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
