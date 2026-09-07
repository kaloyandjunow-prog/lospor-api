import { Prisma } from "@/generated/prisma/client"
import { canonicalizePreopPatch } from "@lospor/core/case-payloads"
import { normalizeOptionCodes } from "@lospor/core/option-aliases"
import { calcApfel, calcRCRI, calcStopBang } from "@lospor/core/scores"
import {
  calculateColds,
  calculatePovoc,
  normalizePediatricAge,
  type ClinicalMode,
} from "@lospor/core/pediatric"
import { calculateMostellerBsa } from "@lospor/core/pediatric-calculators"
import {
  copyKey,
  safeEnum,
  taggedListToStorage,
  toFloatOrNull,
  toIntOrNull,
  type PreopRawInput,
} from "./shared"

export function mapPreop(rawPreop: Record<string, unknown>): Prisma.PreoperativeAssessmentUncheckedCreateWithoutCaseInput {
  const preop = canonicalizePreopPatch(rawPreop) as PreopRawInput
  const upperLipBiteTest =
    preop.upperLipBiteTest ??
    (preop.ulbt === "I" ? "CLASS_I" : preop.ulbt === "II" ? "CLASS_II" : preop.ulbt === "III" ? "CLASS_III" : null)
  const difficultAirwayHistory = preop.difficultAirwayHistory ?? preop.difficultAirway ?? null
  const familyAnesthesiaProblems = preop.familyAnesthesiaProblems ?? preop.familyProblems ?? null
  const familyAnesthesiaDetails = familyAnesthesiaProblems
    ? preop.familyAnesthesiaDetails ?? preop.familyProblemNotes ?? null
    : null
  const allergies = preop.allergies ?? null
  const allergyDetails = allergies ? taggedListToStorage(preop.allergyDetails) : null
  // Item 20: Validate/compute BMI from height+weight; discard client BMI if it diverges >10%
  //
  // Stored at full precision on purpose — this is a research database, and the
  // mean of precisely-stored BMIs is a better statistic than the mean of values
  // pre-rounded to one decimal. `pediatric-mappers.test.ts` pins that to four
  // decimal places.
  //
  // Rounding belongs at the display edge, and only there: the anaesthesia record
  // was printing "BMI 26.1224489795918" because CaseSummary rendered this value
  // raw. Fixed there, not here.
  const heightCm = preop.heightCm ?? null
  const weightKg = preop.weightKg ?? null
  let bmi: number | null = null
  if (heightCm != null && weightKg != null && heightCm > 0) {
    const computedBmi = weightKg / Math.pow(heightCm / 100, 2)
    if (preop.bmi != null) {
      const clientBmi = Number(preop.bmi)
      bmi = Math.abs(clientBmi - computedBmi) / computedBmi <= 0.1 ? clientBmi : computedBmi
    } else {
      bmi = computedBmi
    }
  }
  const bsaResult = heightCm != null && weightKg != null
    ? calculateMostellerBsa({ heightCm, weightKg })
    : null
  const bodySurfaceAreaM2 = bsaResult?.available ? bsaResult.value.squareMetres : null
  const pediatric = preop.clinicalMode === "PEDIATRIC"
  const normalizedAge = pediatric
    && preop.ageValue != null
    && preop.ageUnit != null
    ? normalizePediatricAge({
        value: preop.ageValue,
        unit: preop.ageUnit,
      })
    : null
  const povoc = pediatric && normalizedAge
    ? calculatePovoc({
        ageYears: normalizedAge.approximateDays / 365.2425,
        surgeryMinutes: preop.povocSurgeryAtLeast30Minutes ? 30 : 0,
        strabismusSurgery: preop.povocStrabismusSurgery ?? false,
        patientOrFamilyHistory: preop.povocHistory ?? false,
      })
    : null
  const coldsCurrentSymptoms = safeEnum(
    preop.coldsCurrentSymptoms,
    ["NONE", "MILD", "MODERATE_OR_SEVERE"] as const,
  )
  const coldsOnset = safeEnum(
    preop.coldsOnset,
    ["MORE_THAN_4_WEEKS", "TWO_TO_4_WEEKS", "LESS_THAN_2_WEEKS"] as const,
  )
  const coldsLungDisease = safeEnum(
    preop.coldsLungDisease,
    ["NONE", "MILD", "MODERATE_OR_SEVERE"] as const,
  )
  const coldsAirwayDevice = safeEnum(
    preop.coldsAirwayDevice,
    ["FACE_MASK_OR_NONE", "SUPRAGLOTTIC", "TRACHEAL_TUBE"] as const,
  )
  const coldsSurgery = safeEnum(
    preop.coldsSurgery,
    ["NON_AIRWAY", "MINOR_AIRWAY", "MAJOR_AIRWAY"] as const,
  )
  const colds = pediatric && preop.coldsApplicable === true
    && coldsCurrentSymptoms && coldsOnset && coldsLungDisease && coldsAirwayDevice && coldsSurgery
    ? calculateColds({
        currentSymptoms: coldsCurrentSymptoms,
        onset: coldsOnset,
        lungDisease: coldsLungDisease,
        airwayDevice: coldsAirwayDevice,
        surgery: coldsSurgery,
      })
    : null

  const ageYears = normalizedAge?.completedYears ?? preop.ageYears ?? null

  // Derived server-side from the stored factors, the same way POVOC and COLDS
  // already are for a pediatric record. A client that sent its own total
  // could send one inconsistent with the factors beside it -- stale, a client
  // bug, or a tampered request -- and nothing here checked.
  const adultScores = pediatric ? null : {
    rcriScore: calcRCRI({
      highRiskSurgery: !!preop.highRiskSurgery,
      ischaemicHeartDisease: !!preop.rcriIschemicHeart,
      congestiveHeartFailure: !!preop.rcriCHF,
      cerebrovascularDisease: !!preop.rcriCVD,
      insulinDependentDiabetes: !!preop.rcriInsulinDM,
      creatinineHigh: !!preop.rcriCreatinine,
    }),
    apfelScore: calcApfel({
      female: preop.sex === "FEMALE",
      // Answered `false` only -- `smoking` is tri-state and this factor is
      // the negation of the question asked. Treating an unanswered `null` as
      // a confirmed non-smoker awarded a point to a question nobody had
      // answered.
      nonSmoker: preop.smoking === false,
      ponvHistory: !!preop.apfelPONVHistory,
      opioidsPlanned: !!preop.apfelPostopOpioids,
    }),
    stopBangScore: calcStopBang({
      snoring: !!preop.stopbangSnoring,
      tired: !!preop.stopbangTired,
      observed: !!preop.stopbangObserved,
      highBP: !!preop.stopbangBP,
      bmi: bmi ?? 0,
      ageOver50: ageYears != null && ageYears > 50,
      neckOver40cm: !!preop.stopbangNeck,
      male: preop.sex === "MALE",
    }),
  }

  // Item 26: Build JSON arrays for diagnoses/procedures; keep legacy string columns for compat
  const diagnosesArr = Array.isArray(preop.diagnoses) ? preop.diagnoses : []
  const proceduresArr = Array.isArray(preop.procedures) ? preop.procedures : []

  return {
    // Items 18 + 19: Use null instead of 0 for missing biometrics — 0 corrupts risk scores
    ageYears,
    ageApproxDays: normalizedAge?.approximateDays ?? null,
    ageValue: preop.ageValue ?? null,
    ageUnit: preop.ageUnit ?? null,
    bodySurfaceAreaM2,
    sex:       preop.sex ?? "UNKNOWN",  // never conflate "not recorded" with "other"
    heightCm,
    weightKg,
    bmi,
    bloodType: safeEnum(preop.bloodType, ["A","B","AB","O"] as const),
    rhFactor:  safeEnum(preop.rhFactor,  ["POSITIVE","NEGATIVE"] as const),

    // Legacy string columns (kept for backward compatibility)
    diagnosis:        diagnosesArr.map(t => t.label).join("; ") || "",
    plannedProcedure: proceduresArr.map(t => t.label).join("; ") || "",
    // Item 26: JSON columns for structured diagnoses/procedures — use Prisma.JsonNull (not undefined) so Prisma clears the column when array is empty
    diagnosesJson:    diagnosesArr.length > 0 ? diagnosesArr : Prisma.JsonNull,
    proceduresJson:   proceduresArr.length > 0 ? proceduresArr : Prisma.JsonNull,
    icdCode:          diagnosesArr[0]?.sub ?? null,
    teamNotes:        preop.teamNotes ?? null,
    physicalExamReport: preop.physicalExamReport ?? null,
    notes:              preop.notes ?? null,
    aiOptIn:          preop.aiOptIn   ?? false,

    comorbidities: preop.comorbidities ?? [],

    allergies,
    allergyDetails,
    latexAllergy: preop.latexAllergy ?? null,
    currentMedications:       taggedListToStorage(preop.currentMedications),
    familyAnesthesiaProblems,
    familyAnesthesiaDetails,
    unexplainedAnaesthesiaComplications: preop.unexplainedAnaesthesiaComplications ?? null,
    malignantHyperthermiaHistory: preop.malignantHyperthermiaHistory ?? null,
    anticipatedDifficultAirway: preop.anticipatedDifficultAirway ?? null,
    dentalProsthetics: preop.dentalProsthetics ?? null,
    looseTeeth: preop.looseTeeth ?? null,
    smoking: preop.smoking ?? null,
    substanceAbuse: preop.substanceAbuse ?? null,

    bpSystolic:       preop.bpSystolic      ?? null,
    bpDiastolic:      preop.bpDiastolic     ?? null,
    heartRate:        preop.heartRate       ?? null,
    heartArrhythmia: preop.heartArrhythmia ?? null,
    spO2:             preop.spO2            ?? null,
    temperature:      preop.temperature     ?? null,
    respiratoryRate:  preop.respiratoryRate ?? null,
    bpUnobtainable:          preop.bpUnobtainable          ?? false,
    heartRateUnobtainable:   preop.heartRateUnobtainable   ?? false,
    spO2Unobtainable:        preop.spO2Unobtainable        ?? false,
    temperatureUnobtainable: preop.temperatureUnobtainable ?? false,
    respiratoryRateUnobtainable: preop.respiratoryRateUnobtainable ?? false,

    mallampati:             preop.mallampati             ?? null,
    mouthOpeningCm:         preop.mouthOpeningCm         ?? null,
    thyromental:            preop.thyromental            ?? null,
    neckMobility:           preop.neckMobility           ?? null,
    upperLipBiteTest,
    retrognathia: preop.retrognathia ?? null,
    prominentIncisors: preop.prominentIncisors ?? null,
    facialHair: preop.facialHair ?? null,
    difficultAirwayHistory,
    difficultAirwayNotes:   difficultAirwayHistory ? preop.difficultAirwayNotes ?? null : null,
    cormackLehane:          preop.cormackLehane          ?? null,
    airwayUnobtainable:     preop.airwayUnobtainable     ?? false,

    asaScore:         preop.asaScore        ?? null,
    elective:         preop.elective         ?? false,
    emergencySurgery: preop.emergencySurgery ?? false,
    highRiskSurgery:  preop.highRiskSurgery  ?? false,

    rcriIschemicHeart: preop.rcriIschemicHeart ?? null,
    rcriCHF: preop.rcriCHF ?? null,
    rcriCVD: preop.rcriCVD ?? null,
    rcriInsulinDM: preop.rcriInsulinDM ?? null,
    rcriCreatinine: preop.rcriCreatinine ?? null,

    rcriScore:     adultScores?.rcriScore ?? null,
    gutaScore:     pediatric ? null : toFloatOrNull(preop.gutaScore),
    apfelScore:    adultScores?.apfelScore ?? null,
    stopBangScore: adultScores?.stopBangScore ?? null,

    apfelPONVHistory: preop.apfelPONVHistory ?? null,
    apfelPostopOpioids: preop.apfelPostopOpioids ?? null,

    stopbangSnoring: preop.stopbangSnoring ?? null,
    stopbangTired: preop.stopbangTired ?? null,
    povocScore:                   povoc?.score ?? null,
    povocRiskPercent:             povoc?.riskPercent ?? null,
    povocSurgeryAtLeast30Minutes: povoc?.factors.surgeryAtLeast30Minutes ?? false,
    povocAgeAtLeast3Years:        povoc?.factors.ageAtLeast3Years ?? false,
    povocStrabismusSurgery:       povoc?.factors.strabismusSurgery ?? false,
    povocHistory:                 povoc?.factors.patientOrFamilyHistory ?? false,
    coldsApplicable:              pediatric ? preop.coldsApplicable ?? false : false,
    coldsScore:                   colds?.score ?? null,
    coldsCurrentSymptoms:         pediatric ? coldsCurrentSymptoms : null,
    coldsOnset:                   pediatric ? coldsOnset : null,
    coldsLungDisease:             pediatric ? coldsLungDisease : null,
    coldsAirwayDevice:            pediatric ? coldsAirwayDevice : null,
    coldsSurgery:                 pediatric ? coldsSurgery : null,
    pediatricFasting:            pediatric ? preop.pediatricFasting ?? [] : [],

    stopbangObserved: preop.stopbangObserved ?? null,
    stopbangBP: preop.stopbangBP ?? null,
    stopbangNeck: preop.stopbangNeck ?? null,

    labResults: preop.labResults ?? [],
  }
}

// Item 21: Strict HH:MM validation — rejects invalid times like "25:90"


export function mapPreopUpdate(
  preop: Record<string, unknown>,
  currentPreop: Record<string, unknown> | null = null,
) {
  const full = mapPreop({ ...(currentPreop ?? {}), ...preop })
  const r: Partial<typeof full> = {}
  // "Present" means the key exists AND is not undefined. Form snapshots send
  // undefined for unfilled optional fields, so undefined keys must be skipped.
  const has = (k: string) => k in preop && preop[k] !== undefined

  // Direct fields: source key name === output key name
  const DIRECT = [
    "ageYears", "ageValue", "ageUnit",
    "sex", "heightCm", "weightKg", "bloodType", "rhFactor",
    "teamNotes", "physicalExamReport", "notes", "aiOptIn", "comorbidities",
    "allergies", "latexAllergy", "currentMedications",
    "unexplainedAnaesthesiaComplications", "malignantHyperthermiaHistory",
    "dentalProsthetics", "looseTeeth", "smoking", "substanceAbuse",
    "bpSystolic", "bpDiastolic", "heartRate", "heartArrhythmia", "spO2", "temperature", "respiratoryRate",
    "bpUnobtainable", "heartRateUnobtainable", "spO2Unobtainable", "temperatureUnobtainable", "respiratoryRateUnobtainable",
    "mallampati", "mouthOpeningCm", "thyromental", "neckMobility",
    "retrognathia", "prominentIncisors", "facialHair", "anticipatedDifficultAirway",
    "difficultAirwayNotes", "cormackLehane", "airwayUnobtainable",
    "asaScore", "elective", "emergencySurgery", "highRiskSurgery",
    "rcriIschemicHeart", "rcriCHF", "rcriCVD", "rcriInsulinDM", "rcriCreatinine",
    "rcriScore", "gutaScore", "apfelScore", "stopBangScore",
    "apfelPONVHistory", "apfelPostopOpioids",
    "stopbangSnoring", "stopbangTired", "stopbangObserved", "stopbangBP", "stopbangNeck",
    "povocScore", "povocRiskPercent", "povocSurgeryAtLeast30Minutes",
    "povocAgeAtLeast3Years", "povocStrabismusSurgery", "povocHistory",
    "coldsApplicable", "coldsScore", "coldsCurrentSymptoms", "coldsOnset",
    "coldsLungDisease", "coldsAirwayDevice", "coldsSurgery", "pediatricFasting",
    "labResults",
  ] as const satisfies readonly (keyof typeof full)[]
  for (const k of DIRECT) {
    if (has(k)) copyKey(r, full, k)
  }
  if (has("allergies") || has("allergyDetails")) {
    if (has("allergies")) r.allergies = full.allergies
    r.allergyDetails = has("allergies") && full.allergies === false
      ? null
      : taggedListToStorage((preop as PreopRawInput).allergyDetails)
  }

  // Computed / aliased fields — include when any contributing source key is present
  if (has("heightCm") || has("weightKg") || has("bmi")) {
    r.bmi = full.bmi
    r.bodySurfaceAreaM2 = full.bodySurfaceAreaM2
  }
  const ageTouched = ["ageValue", "ageUnit", "clinicalMode"].some(has)
  if (ageTouched) {
    r.ageYears = full.ageYears
    r.ageApproxDays = full.ageApproxDays
  }
  if (
    has("ageValue") || has("ageUnit") || has("povocSurgeryAtLeast30Minutes")
    || has("povocStrabismusSurgery") || has("povocHistory")
  ) {
    r.povocScore = full.povocScore
    r.povocRiskPercent = full.povocRiskPercent
    r.povocAgeAtLeast3Years = full.povocAgeAtLeast3Years
  }
  if (
    has("coldsApplicable") || has("coldsCurrentSymptoms") || has("coldsOnset")
    || has("coldsLungDisease") || has("coldsAirwayDevice") || has("coldsSurgery")
  ) {
    r.coldsScore = full.coldsScore
  }
  if (has("diagnoses")) {
    r.diagnosis      = full.diagnosis
    r.diagnosesJson  = full.diagnosesJson
    r.icdCode        = full.icdCode
  }
  if (has("procedures")) {
    r.plannedProcedure = full.plannedProcedure
    r.proceduresJson   = full.proceduresJson
  }
  if (has("familyAnesthesiaProblems") || has("familyProblems")) {
    r.familyAnesthesiaProblems = full.familyAnesthesiaProblems
    if (full.familyAnesthesiaProblems === false) r.familyAnesthesiaDetails = null
  }
  if (has("familyAnesthesiaDetails")  || has("familyProblemNotes"))  r.familyAnesthesiaDetails  = full.familyAnesthesiaDetails
  if (has("upperLipBiteTest") || has("ulbt"))                        r.upperLipBiteTest         = full.upperLipBiteTest
  if (has("difficultAirwayHistory") || has("difficultAirway")) {
    r.difficultAirwayHistory = full.difficultAirwayHistory
    if (full.difficultAirwayHistory === false) r.difficultAirwayNotes = null
  }

  if ((preop as PreopRawInput).clinicalMode === "PEDIATRIC") {
    r.rcriIschemicHeart = false
    r.rcriCHF = false
    r.rcriCVD = false
    r.rcriInsulinDM = false
    r.rcriCreatinine = false
    r.rcriScore = null
    r.gutaScore = null
    r.apfelScore = null
    r.stopBangScore = null
    r.apfelPONVHistory = false
    r.apfelPostopOpioids = false
    r.stopbangSnoring = false
    r.stopbangTired = false
    r.stopbangObserved = false
    r.stopbangBP = false
    r.stopbangNeck = false
  }
  return r
}

// For UPDATE operations: same partial-update semantics as mapPreopUpdate.
