import { z } from "zod"
import {
  CLINICAL_NUMBER_RULES,
  validateIntraopPatch,
  validatePostopPatch,
  validatePreopPatch,
  type ClinicalSection,
  type ClinicalValidationResult,
} from "@lospor/core/clinical-validation"

// Three distinct inputs that must stay distinct — collapsing any pair of them
// has already cost stored clinical data once:
//
//   undefined  → the client did not mention this field. Leave the stored value
//                alone. (Returning null here made every field-level PATCH wipe
//                the fields it did not mention.)
//   null / ""  → the user actively cleared the field. Store null.
//   "12abc"    → a typo. Must FAIL validation so the field is reported back in
//                `rejectedFields`. Returning null here silently overwrote a
//                real measurement with "cleared" and told nobody — the same
//                failure mode as the undefined case, one step further along.
//
// Unparseable input is therefore passed through untouched: `z.number()` then
// rejects it, which is exactly what we want it to do.
const numPreprocess = (v: unknown): unknown => {
  if (v === undefined) return undefined
  if (v === "" || v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : v
}
const intPreprocess = (v: unknown): unknown => {
  const n = numPreprocess(v)
  return typeof n === "number" ? Math.round(n) : n
}


// Range-bounded variants — used for fields where physically impossible values should be rejected
const numberRule = (section: ClinicalSection, field: string) => {
  const rule = CLINICAL_NUMBER_RULES[section][field]
  if (!rule) throw new Error(`Missing Core number rule for ${section}.${field}`)
  return rule
}
const cNum = (section: ClinicalSection, field: string) => {
  const { min, max } = numberRule(section, field)
  return z.preprocess(numPreprocess, z.number().min(min).max(max).nullable().optional())
}
const cInt = (section: ClinicalSection, field: string) => {
  const { min, max } = numberRule(section, field)
  return z.preprocess(intPreprocess, z.number().int().min(min).max(max).nullable().optional())
}

function addCoreIssues(result: ClinicalValidationResult, ctx: z.RefinementCtx): void {
  for (const issue of result.issues) {
    ctx.addIssue({
      code: "custom",
      path: issue.path,
      message: issue.code,
    })
  }
}

// Item 26: Canonical format for diagnoses/procedures — { label, code?, sub?, system? }
const labelledItem = z.object({
  label:  z.string(),
  code:   z.string().optional(),
  sub:    z.string().optional(),
  system: z.string().optional(),
}).passthrough()

export const preopSchema = z.object({
  ageYears:  cInt("preop", "ageYears"),
  sex:       z.enum(["MALE", "FEMALE", "OTHER", "UNKNOWN"]).optional(),
  heightCm:  cNum("preop", "heightCm"),
  weightKg:  cNum("preop", "weightKg"),
  bmi:       cNum("preop", "bmi"),
  bloodType: z.enum(["A", "B", "AB", "O"]).nullable().optional(),
  rhFactor:  z.enum(["POSITIVE", "NEGATIVE"]).nullable().optional(),

  diagnosis:            z.string().max(1000).optional(),
  diagnoses:            z.array(labelledItem).optional(),
  plannedProcedure:     z.string().max(1000).optional(),
  procedures:           z.array(labelledItem).optional(),
  icdCode:              z.string().max(20).nullable().optional(),
  teamNotes:            z.string().max(500).nullable().optional(),
  physicalExamReport:   z.string().max(500).nullable().optional(),
  notes:                z.string().max(2000).nullable().optional(),
  aiOptIn:              z.boolean().optional(),

  comorbidities: z.array(labelledItem).optional(),

  allergies:                z.boolean().optional(),
  allergyDetails:           z.union([z.string(), z.array(labelledItem)]).optional(),
  latexAllergy:             z.boolean().optional(),
  currentMedications:       z.union([z.string(), z.array(labelledItem)]).optional(),
  familyAnesthesiaProblems: z.boolean().optional(),
  familyAnesthesiaDetails:  z.string().max(500).nullable().optional(),
  dentalProsthetics:        z.boolean().optional(),
  looseTeeth:               z.boolean().optional(),
  smoking:                  z.boolean().optional(),
  substanceAbuse:           z.boolean().optional(),

  bpSystolic:      cInt("preop", "bpSystolic"),
  bpDiastolic:     cInt("preop", "bpDiastolic"),
  heartRate:       cInt("preop", "heartRate"),
  heartArrhythmia: z.boolean().optional(),
  spO2:            cNum("preop", "spO2"),
  temperature:     cNum("preop", "temperature"),
  respiratoryRate: cInt("preop", "respiratoryRate"),
  bpUnobtainable:          z.boolean().optional(),
  heartRateUnobtainable:   z.boolean().optional(),
  spO2Unobtainable:        z.boolean().optional(),
  temperatureUnobtainable: z.boolean().optional(),
  respiratoryRateUnobtainable: z.boolean().optional(),

  mallampati:             z.enum(["I", "II", "III", "IV"]).nullable().optional(),
  mouthOpeningCm:         cNum("preop", "mouthOpeningCm"),
  thyromental:            cNum("preop", "thyromental"),
  neckMobility:           z.enum(["FULL", "LIMITED", "FIXED"]).nullable().optional(),
  upperLipBiteTest:       z.enum(["CLASS_I", "CLASS_II", "CLASS_III"]).nullable().optional(),
  retrognathia:           z.boolean().optional(),
  prominentIncisors:      z.boolean().optional(),
  facialHair:             z.boolean().optional(),
  difficultAirwayHistory: z.boolean().optional(),
  difficultAirwayNotes:   z.string().max(500).nullable().optional(),
  cormackLehane:          z.enum(["I", "IIa", "IIb", "III", "IV"]).nullable().optional(),
  airwayUnobtainable:     z.boolean().optional(),

  asaScore:        z.enum(["I", "II", "III", "IV", "V", "VI"]).nullable().optional(),
  elective:         z.boolean().optional(),
  emergencySurgery: z.boolean().optional(),
  rcriScore:       cInt("preop", "rcriScore"),
  gutaScore:       cNum("preop", "gutaScore"),
  apfelScore:      cInt("preop", "apfelScore"),
  stopBangScore:   cInt("preop", "stopBangScore"),

  // Item 27: Strict lab result shape matching the lab scan extractor output
  labResults: z.array(z.object({
    test:  z.string(),
    value: z.string(),
    unit:  z.string().optional(),
    flag:  z.string().optional(),
  })).optional(),
}).passthrough().superRefine((data, ctx) => addCoreIssues(validatePreopPatch(data), ctx))

export const intraopSchema = z.object({
  monthYear:       z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  durationMinutes: cInt("intraop", "durationMinutes"),
  startTime: z.string().optional(),
  endTime:   z.string().nullable().optional(),

  positions:  z.array(z.unknown()).optional(),
  techniques: z.array(z.unknown()).optional(),

  airwayDevice:   z.enum(["FACE_MASK", "LMA", "ORAL_ETT", "NASAL_ETT", "SURGICAL_AIRWAY"]).nullable().optional(),
  tubeSize:       cNum("intraop", "tubeSize"),
  cuffed:         z.boolean().nullable().optional(),
  peepCmH2O:      cNum("intraop", "peepCmH2O"),
  ippv:           z.boolean().optional(),
  jetVentilation: z.boolean().optional(),
  fob:            z.boolean().optional(),
  airwayTools:      z.array(z.unknown()).optional(),
  airwayNotes:      z.string().max(2000).nullable().optional(),
  cormackLehane:    z.enum(["I", "IIa", "IIb", "III", "IV"]).nullable().optional(),
  airwayDevices:    z.array(z.unknown()).optional(),
  ventilationModes: z.array(z.unknown()).optional(),
  lmaSize:          cNum("intraop", "lmaSize"),
  oralTubeSize:     cNum("intraop", "oralTubeSize"),
  oralCuffed:       z.boolean().nullable().optional(),
  nasalTubeSize:    cNum("intraop", "nasalTubeSize"),
  nasalCuffed:      z.boolean().nullable().optional(),
  dltType:          z.string().max(50).nullable().optional(),
  dltSide:          z.string().max(20).nullable().optional(),
  dltSize:          cNum("intraop", "dltSize"),
  endobronchialSize: cNum("intraop", "endobronchialSize"),

  volatileAgent:   z.enum(["SEVOFLURANE", "DESFLURANE", "ISOFLURANE"]).nullable().optional(),

  plexusBlock:      z.enum(["AXILLARY", "INTERSCALENE", "SUPRACLAVICULAR", "INFRACLAVICULAR", "FEMORAL", "SCIATIC", "POPLITEAL", "TAP", "ERECTOR_SPINAE"]).nullable().optional(),
  cvkSite:          z.enum(["INTERNAL_JUGULAR", "EXTERNAL_JUGULAR", "SUBCLAVIAN", "FEMORAL"]).nullable().optional(),
  arterialLineSite: z.enum(["RADIAL", "DORSALIS_PEDIS", "FEMORAL", "BRACHIAL"]).nullable().optional(),

  ecg: z.boolean().optional(), urinaryCatheter: z.boolean().optional(), stomachTube: z.boolean().optional(),
  spO2Monitor: z.boolean().optional(), invasiveBP: z.boolean().optional(), cvpMonitor: z.boolean().optional(),
  bglMonitor: z.boolean().optional(), bloodGasMonitor: z.boolean().optional(), neuroMonitor: z.boolean().optional(),
  nbpMonitor: z.boolean().optional(), etco2Monitor: z.boolean().optional(), tempMonitor: z.boolean().optional(),
  paCatheter: z.boolean().optional(), tee: z.boolean().optional(), bis: z.boolean().optional(),
  entropyMonitor: z.boolean().optional(), nirsMonitor: z.boolean().optional(), evokedPotentials: z.boolean().optional(),
  tofMonitor: z.boolean().optional(),

  vascularAccesses:     z.array(z.unknown()).optional(),
  premedicationEvening: z.string().max(500).nullable().optional(),
  premedicationMorning: z.string().max(500).nullable().optional(),
  drugsAdministered:    z.array(z.unknown()).optional(),

  crystalloidsMl:    cInt("intraop", "crystalloidsMl"),
  colloidsMl:        cInt("intraop", "colloidsMl"),
  bloodMl:           cInt("intraop", "bloodMl"),
  bloodProductsNote: z.string().max(1000).nullable().optional(),
  urineMl:           cInt("intraop", "urineMl"),

  timeSeriesData: z.array(z.unknown()).optional(),
  keyEvents:      z.array(z.unknown()).optional(),
  complications:  z.string().max(2000).nullable().optional(),
}).passthrough().superRefine((data, ctx) => addCoreIssues(validateIntraopPatch(data), ctx))

export const postopSchema = z.object({
  aldreteActivity:      cInt("postop", "aldreteActivity"),
  aldreteRespiration:   cInt("postop", "aldreteRespiration"),
  aldreteCirculation:   cInt("postop", "aldreteCirculation"),
  aldreteConsciousness: cInt("postop", "aldreteConsciousness"),
  aldreteSpO2:          cInt("postop", "aldreteSpO2"),
  aldreteTotal:         cInt("postop", "aldreteTotal"),

  recoveryBpSystolic:  cInt("postop", "recoveryBpSystolic"),
  recoveryBpDiastolic: cInt("postop", "recoveryBpDiastolic"),
  recoveryHeartRate:   cInt("postop", "recoveryHeartRate"),
  recoverySpO2:        cNum("postop", "recoverySpO2"),
  painScoreNRS:        cInt("postop", "painScoreNRS"),
  ponv:               z.boolean().optional(),
  temperatureCelsius: cNum("postop", "temperatureCelsius"),
  recoveryBpUnobtainable:          z.boolean().optional(),
  recoveryHeartRateUnobtainable:   z.boolean().optional(),
  recoverySpO2Unobtainable:        z.boolean().optional(),
  recoveryTemperatureUnobtainable: z.boolean().optional(),

  complications:    z.string().max(2000).nullable().optional(),
  disposition:      z.enum(["WARD", "PACU", "ICU"]).nullable().optional(),
  dispositionNotes: z.string().max(1000).nullable().optional(),
  handoverItems:    z.array(z.unknown()).optional(),
}).passthrough().superRefine((data, ctx) => addCoreIssues(validatePostopPatch(data), ctx))
