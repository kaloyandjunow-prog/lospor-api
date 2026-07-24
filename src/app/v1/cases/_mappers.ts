// Shared data-mapping helpers for POST and PATCH case routes
import { Prisma } from "@/generated/prisma/client"
import {
  durationMinutesBetween,
  endInstantForWallClock,
  instantFromLocalTime,
  isValidTimeZone,
} from "@/lib/intraop-time"
import {
  canonicalizeIntraopPatch,
  canonicalizePostopPatch,
  canonicalizePreopPatch,
} from "@lospor/core/case-payloads"
import { normalizeOptionCodes } from "@lospor/core/option-aliases"

// Copies full[k] into r[k] for each key present in the raw payload. A plain
// `r[k] = full[k]` inside a loop over a key UNION can't statically prove the
// value type for a given k matches r's expected type at that same k (TS
// doesn't correlate union members across separate indexed accesses) — this
// generic signature binds K once per call so the assignment type-checks
// without a cast.
function copyKey<T, K extends keyof T>(r: Partial<T>, full: T, k: K): void {
  r[k] = full[k]
}

// Mappers accept a deliberately permissive payload: canonical field names
// (matching the Prisma columns) plus legacy/mobile aliases (ulbt,
// difficultAirway, familyProblems, etc.) that predate the canonical names.
// Casting once here — instead of at each of the ~150 individual field reads
// below — keeps every `preop.x` read properly typed against the real column
// type while still tolerating the alias keys the rest of the function checks.
type PreopRawInput = Partial<Prisma.PreoperativeAssessmentUncheckedCreateWithoutCaseInput> & {
  ulbt?: string
  difficultAirway?: boolean
  familyProblems?: boolean
  familyProblemNotes?: string | null
  diagnoses?: { label?: string; sub?: string; code?: string }[]
  procedures?: { label?: string; sub?: string; code?: string; group?: string; domain?: string; description?: string }[]
  allergyDetails?: string | { label?: string; inn?: string; atcCode?: string; dose?: string; route?: string; frequency?: string }[] | null
  currentMedications?: string | { label?: string; inn?: string; atcCode?: string; dose?: string; route?: string; frequency?: string }[] | null
}

type TaggedDrugList = PreopRawInput["currentMedications"] | PreopRawInput["allergyDetails"]

function taggedListToStorage(value: TaggedDrugList): string | null {
  if (!Array.isArray(value)) return value ?? null
  const items = value
    .filter(item => item && (item.label || item.inn || item.atcCode))
    .map(item => ({
      label: item.label ?? item.inn ?? item.atcCode ?? "",
      inn: item.inn ?? undefined,
      atcCode: item.atcCode ?? undefined,
      dose: item.dose ?? undefined,
      route: item.route ?? undefined,
      frequency: item.frequency ?? undefined,
    }))
  return items.length ? JSON.stringify(items) : null
}

export function mapPreop(rawPreop: Record<string, unknown>): Prisma.PreoperativeAssessmentUncheckedCreateWithoutCaseInput {
  const preop = canonicalizePreopPatch(rawPreop) as PreopRawInput
  const upperLipBiteTest =
    preop.upperLipBiteTest ??
    (preop.ulbt === "I" ? "CLASS_I" : preop.ulbt === "II" ? "CLASS_II" : preop.ulbt === "III" ? "CLASS_III" : null)
  const difficultAirwayHistory = preop.difficultAirwayHistory ?? preop.difficultAirway ?? false
  const familyAnesthesiaProblems = preop.familyAnesthesiaProblems ?? preop.familyProblems ?? false
  const familyAnesthesiaDetails = familyAnesthesiaProblems
    ? preop.familyAnesthesiaDetails ?? preop.familyProblemNotes ?? null
    : null
  const allergies = preop.allergies ?? false
  const allergyDetails = allergies ? taggedListToStorage(preop.allergyDetails) : null
  // Item 20: Validate/compute BMI from height+weight; discard client BMI if it diverges >10%
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

  // Item 26: Build JSON arrays for diagnoses/procedures; keep legacy string columns for compat
  const diagnosesArr = Array.isArray(preop.diagnoses) ? preop.diagnoses : []
  const proceduresArr = Array.isArray(preop.procedures) ? preop.procedures : []

  return {
    // Items 18 + 19: Use null instead of 0 for missing biometrics — 0 corrupts risk scores
    ageYears:  preop.ageYears  ?? null,
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
    latexAllergy:             preop.latexAllergy             ?? false,
    currentMedications:       taggedListToStorage(preop.currentMedications),
    familyAnesthesiaProblems,
    familyAnesthesiaDetails,
    dentalProsthetics:        preop.dentalProsthetics        ?? false,
    looseTeeth:               preop.looseTeeth               ?? false,
    smoking:                  preop.smoking                  ?? false,
    substanceAbuse:           preop.substanceAbuse           ?? false,

    bpSystolic:       preop.bpSystolic      ?? null,
    bpDiastolic:      preop.bpDiastolic     ?? null,
    heartRate:        preop.heartRate       ?? null,
    heartArrhythmia:  preop.heartArrhythmia ?? false,
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
    retrognathia:           preop.retrognathia           ?? false,
    prominentIncisors:      preop.prominentIncisors      ?? false,
    facialHair:             preop.facialHair             ?? false,
    difficultAirwayHistory,
    difficultAirwayNotes:   difficultAirwayHistory ? preop.difficultAirwayNotes ?? null : null,
    cormackLehane:          preop.cormackLehane          ?? null,
    airwayUnobtainable:     preop.airwayUnobtainable     ?? false,

    asaScore:         preop.asaScore        ?? null,
    elective:         preop.elective         ?? false,
    emergencySurgery: preop.emergencySurgery ?? false,
    highRiskSurgery:  preop.highRiskSurgery  ?? false,

    rcriIschemicHeart:  preop.rcriIschemicHeart  ?? false,
    rcriCHF:            preop.rcriCHF            ?? false,
    rcriCVD:            preop.rcriCVD            ?? false,
    rcriInsulinDM:      preop.rcriInsulinDM      ?? false,
    rcriCreatinine:     preop.rcriCreatinine     ?? false,

    rcriScore:    toIntOrNull(preop.rcriScore),
    gutaScore:    toFloatOrNull(preop.gutaScore),
    apfelScore:   toIntOrNull(preop.apfelScore),
    stopBangScore: toIntOrNull(preop.stopBangScore),

    apfelPONVHistory:   preop.apfelPONVHistory   ?? false,
    apfelPostopOpioids: preop.apfelPostopOpioids ?? false,

    stopbangSnoring:  preop.stopbangSnoring  ?? false,
    stopbangTired:    preop.stopbangTired    ?? false,
    stopbangObserved: preop.stopbangObserved ?? false,
    stopbangBP:       preop.stopbangBP       ?? false,
    stopbangNeck:     preop.stopbangNeck     ?? false,

    labResults: preop.labResults ?? [],
  }
}

// Item 21: Strict HH:MM validation — rejects invalid times like "25:90"
const HHMMRE = /^([01]\d|2[0-3]):([0-5]\d)$/

// Return v if it is one of the allowed values, otherwise null.
// Prevents empty strings / unknown values from breaking Prisma enum fields.
function safeEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return (allowed as readonly unknown[]).includes(v) ? (v as T) : null
}

function toIntOrNull(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = parseInt(String(v), 10)
  return isNaN(n) ? null : n
}

function toFloatOrNull(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = parseFloat(String(v))
  return isNaN(n) ? null : n
}

// For UPDATE operations: only include fields that were explicitly present in the payload.
// Using mapIntraop for updates fills in ?? defaults for every missing field, silently
// overwriting existing DB data with zeros/empty arrays on every partial save.
export function mapIntraopUpdate(intraop: Record<string, unknown>) {
  const full = mapIntraop(intraop)
  const r: Partial<typeof full> = {}
  const has = (k: string) => k in intraop

  // Timing — only update when the relevant field was provided
  if (has("monthYear"))       r.monthYear       = full.monthYear
  if (has("startTime") || has("endTime") || has("endTimeNextDay") || has("startedAt") || has("endedAt")) {
    // Only write a start time when it is real. An absent or malformed value
    // means "not mentioned in this partial save", never "clear it" — otherwise
    // an autosave triggered by an unrelated field would blank a time the
    // clinician had already set.
    if (has("startTime") && HHMMRE.test(String(intraop.startTime ?? ""))) r.startTime = full.startTime
    if (has("endTime"))       r.endTime         = full.endTime
    if (has("startedAt")) r.startedAt = full.startedAt
    if (has("endedAt"))   r.endedAt   = full.endedAt
    if (full.timezone)        r.timezone        = full.timezone
                              r.durationMinutes = full.durationMinutes
  }

  // Direct scalar fields
  const DIRECT = [
    "positions","techniques",
    "tubeSize","cuffed","peepCmH2O","airwayNotes","cormackLehane",
    "lmaSize","oralTubeSize","oralCuffed","nasalTubeSize","nasalCuffed",
    "dltType","dltSide","dltSize","endobronchialSize",
    "volatileAgent",
    "plexusBlock","cvkSite","arterialLineSite",
    "ecg","urinaryCatheter","stomachTube","spO2Monitor","invasiveBP","cvpMonitor",
    "bglMonitor","bloodGasMonitor","neuroMonitor","nbpMonitor","etco2Monitor",
    "tempMonitor","paCatheter","tee","bis","entropyMonitor","nirsMonitor",
    "evokedPotentials","tofMonitor",
    "vascularAccesses","premedicationEvening","premedicationMorning","drugsAdministered",
    // crystalloidsMl/colloidsMl/bloodMl are intentionally NOT accepted here:
    // they are derived from the fluid events and written server-side in
    // rebuildProjection (case-events.ts), so a client PATCH can't override the
    // single source of truth. The read path (below) still returns them.
    "bloodProductsNote","urineMl","complications",
  ] as const satisfies readonly (keyof typeof full)[]
  for (const k of DIRECT) {
    if (has(k)) copyKey(r, full, k)
  }

  // Aliased source keys
  if (has("vitals"))       r.timeSeriesData = full.timeSeriesData
  if (has("timetableData")) r.keyEvents      = full.keyEvents

  // Computed from compound sources
  if (has("airwayTools") || has("fob")) r.airwayTools = full.airwayTools
  if (has("airwayDevices") || has("airwayDevice")) {
    r.airwayDevices = full.airwayDevices
    r.airwayDevice  = full.airwayDevice
  }
  if (has("ventilationModes")) {
    r.ventilationModes = full.ventilationModes
    r.ippv             = full.ippv
    r.jetVentilation   = full.jetVentilation
  } else {
    if (has("ippv"))           r.ippv           = full.ippv
    if (has("jetVentilation")) r.jetVentilation = full.jetVentilation
  }

  return r
}

type IntraopRawInput = Partial<Prisma.IntraoperativeRecordUncheckedCreateWithoutCaseInput> & {
  fob?: boolean
  vitals?: Prisma.InputJsonValue
  timetableData?: Prisma.InputJsonValue
  endTimeNextDay?: boolean
}

/**
 * Work out the real instants a case started and ended at.
 *
 * Clients may send either form:
 *
 *  - `startedAt`/`endedAt` as full ISO instants plus `timezone` — what current
 *    clients send, and the only form that can be placed on a real timeline.
 *  - a bare `startTime`/`endTime` of "HH:MM" — older clients, and offline
 *    payloads queued before an upgrade. Combined with `timezone` and the case
 *    day, that still yields a correct instant.
 *
 * Without a usable zone there is no honest conversion, so the instants are left
 * null and the legacy wall-clock columns carry the value alone. A guessed
 * timestamp is worse than a missing one: it is indistinguishable from a real
 * one afterwards.
 */
function resolveIntraopInstants(intraop: Record<string, unknown>): {
  startedAt: Date | null
  endedAt: Date | null
  timezone: string | null
} {
  const tz = isValidTimeZone(intraop.timezone) ? intraop.timezone : null

  const asInstant = (v: unknown): Date | null => {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
    if (typeof v !== "string" || !v) return null
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }

  // The day the case belongs to, for converting a bare "HH:MM".
  const day = asInstant(intraop.caseDay) ?? asInstant(intraop.createdAt) ?? new Date()
  const fromWallClock = (hhmm: unknown): Date | null =>
    tz && typeof hhmm === "string" && HHMMRE.test(hhmm)
      ? instantFromLocalTime(day, hhmm, tz)
      : null

  const startedAt = asInstant(intraop.startedAt) ?? fromWallClock(intraop.startTime)
  const endedAt = asInstant(intraop.endedAt) ?? (
    startedAt && tz && typeof intraop.endTime === "string"
      ? endInstantForWallClock(startedAt, intraop.endTime, tz, intraop.endTimeNextDay === true)
      : null
  )

  return {
    startedAt,
    endedAt,
    timezone:  tz,
  }
}

export function mapIntraop(rawIntraop: Record<string, unknown>): Prisma.IntraoperativeRecordUncheckedCreateWithoutCaseInput {
  const intraop = canonicalizeIntraopPatch(rawIntraop) as IntraopRawInput
  // Use a stable reference date (2000-01-01) for startTime/endTime — only the HH:MM matters for the timetable.
  const REF_DATE = "2000-01-01"
  const isHHMM  = (s: unknown): s is string => typeof s === "string" && HHMMRE.test(s)
  const toMins = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m }
  const rawStart = intraop.startTime
  const rawEnd   = intraop.endTime
  const endRefDate = (() => {
    const crossedMidnight = isHHMM(rawStart) && isHHMM(rawEnd)
      && toMins(rawEnd) < toMins(rawStart)
    if (!crossedMidnight && !intraop.endTimeNextDay) return REF_DATE
    const d = new Date(REF_DATE + "T12:00:00Z")
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().split("T")[0]
  })()
  const durationMinutes = (() => {
    if (!isHHMM(rawStart) || !isHHMM(rawEnd)) return (intraop.durationMinutes as number | null | undefined) ?? null
    let diff = toMins(rawEnd) - toMins(rawStart)
    if (diff < 0) diff += 24 * 60
    return diff
  })()
  const instants = resolveIntraopInstants(intraop)
  return {
    monthYear:       intraop.monthYear ?? null,
    // A real elapsed time when we have real instants; otherwise the wall-clock
    // subtraction, which cannot see a daylight-saving change.
    durationMinutes: durationMinutesBetween(instants.startedAt, instants.endedAt) ?? durationMinutes,
    // "Not started" is null, never a fabricated midnight. A JS Date is always
    // truthy, so a sentinel here defeated every `if (startTime)` guard in the
    // app — locking the form to 00:00 and killing the finalise check.
    startTime: isHHMM(intraop.startTime) ? new Date(`${REF_DATE}T${intraop.startTime}:00.000Z`)    : null,
    endTime:   isHHMM(intraop.endTime)   ? new Date(`${endRefDate}T${intraop.endTime}:00.000Z`)   : null,
    startedAt: instants.startedAt,
    endedAt:   instants.endedAt,
    timezone:  instants.timezone,
    positions:       intraop.positions        ?? [],
    techniques: normalizeOptionCodes(
      "TECHNIQUE",
      Array.isArray(intraop.techniques)
        ? intraop.techniques.filter((value): value is string => typeof value === "string")
        : [],
    ),
    tubeSize:        intraop.tubeSize        ?? null,
    cuffed:          intraop.cuffed          ?? null,
    lmaSize:         intraop.lmaSize         ?? null,
    oralTubeSize:    intraop.oralTubeSize    ?? null,
    oralCuffed:      intraop.oralCuffed      ?? null,
    nasalTubeSize:   intraop.nasalTubeSize   ?? null,
    nasalCuffed:     intraop.nasalCuffed     ?? null,
    peepCmH2O:       intraop.peepCmH2O       ?? null,
    airwayTools: (() => {
      const tools: string[] = Array.isArray(intraop.airwayTools) ? intraop.airwayTools : []
      // Back-compat: if legacy fob=true, include "FOB" in tools
      if (intraop.fob && !tools.includes("FOB")) return [...tools, "FOB"]
      return tools
    })(),
    airwayNotes:     intraop.airwayNotes     ?? null,
    cormackLehane:   safeEnum(intraop.cormackLehane, ["I","IIa","IIb","III","IV"] as const),
    airwayDevices:   Array.isArray(intraop.airwayDevices)    ? intraop.airwayDevices    : [],
    ventilationModes:Array.isArray(intraop.ventilationModes) ? intraop.ventilationModes : [],
    dltType:         intraop.dltType         ?? null,
    dltSide:         intraop.dltSide         ?? null,
    dltSize:         intraop.dltSize         ?? null,
    endobronchialSize: intraop.endobronchialSize ?? null,
    // Legacy scalar fields derived from new JSON arrays for backwards compat
    airwayDevice: safeEnum(
      (() => {
        const devs: string[] = Array.isArray(intraop.airwayDevices) ? intraop.airwayDevices : []
        const VALID = ["FACE_MASK","LMA","ORAL_ETT","NASAL_ETT","SURGICAL_AIRWAY"] as const
        return devs.find((d: string) => (VALID as readonly string[]).includes(d)) ?? intraop.airwayDevice ?? null
      })(),
      ["FACE_MASK","LMA","ORAL_ETT","NASAL_ETT","SURGICAL_AIRWAY"] as const
    ),
    ippv:            Array.isArray(intraop.ventilationModes)
      ? (intraop.ventilationModes as string[]).some((m: string) => !["Spontaneous","Jet"].includes(m))
      : (intraop.ippv ?? false),
    jetVentilation:  Array.isArray(intraop.ventilationModes)
      ? (intraop.ventilationModes as string[]).includes("Jet")
      : (intraop.jetVentilation ?? false),
    volatileAgent:   safeEnum(intraop.volatileAgent,   ["SEVOFLURANE","DESFLURANE","ISOFLURANE"] as const),
    plexusBlock:     safeEnum(intraop.plexusBlock, ["AXILLARY","INTERSCALENE","SUPRACLAVICULAR","INFRACLAVICULAR","FEMORAL","SCIATIC","POPLITEAL","TAP","ERECTOR_SPINAE"] as const),
    cvkSite:         safeEnum(intraop.cvkSite, ["INTERNAL_JUGULAR","EXTERNAL_JUGULAR","SUBCLAVIAN","FEMORAL"] as const),
    arterialLineSite:safeEnum(intraop.arterialLineSite, ["RADIAL","DORSALIS_PEDIS","FEMORAL","BRACHIAL"] as const),
    ecg:              intraop.ecg              ?? false,
    urinaryCatheter:  intraop.urinaryCatheter  ?? false,
    stomachTube:      intraop.stomachTube      ?? false,
    spO2Monitor:      intraop.spO2Monitor      ?? true,
    invasiveBP:       intraop.invasiveBP       ?? false,
    cvpMonitor:       intraop.cvpMonitor       ?? false,
    bglMonitor:       intraop.bglMonitor       ?? false,
    bloodGasMonitor:  intraop.bloodGasMonitor  ?? false,
    neuroMonitor:     intraop.neuroMonitor     ?? false,
    nbpMonitor:       intraop.nbpMonitor       ?? true,
    etco2Monitor:     intraop.etco2Monitor     ?? false,
    tempMonitor:      intraop.tempMonitor      ?? false,
    paCatheter:       intraop.paCatheter       ?? false,
    tee:              intraop.tee              ?? false,
    bis:              intraop.bis              ?? false,
    entropyMonitor:   intraop.entropyMonitor   ?? false,
    nirsMonitor:      intraop.nirsMonitor      ?? false,
    evokedPotentials: intraop.evokedPotentials ?? false,
    tofMonitor:       intraop.tofMonitor       ?? false,
    vascularAccesses:  intraop.vascularAccesses ?? [],
    premedicationEvening: intraop.premedicationEvening ?? null,
    premedicationMorning: intraop.premedicationMorning ?? null,
    drugsAdministered: intraop.drugsAdministered ?? [],
    timeSeriesData:    intraop.vitals            ?? [],
    keyEvents:         intraop.timetableData     ?? Prisma.JsonNull,
    crystalloidsMl:    intraop.crystalloidsMl    ?? null,
    colloidsMl:        intraop.colloidsMl        ?? null,
    bloodMl:           intraop.bloodMl           ?? null,
    bloodProductsNote: intraop.bloodProductsNote ?? null,
    urineMl:           intraop.urineMl           ?? null,
    complications:     intraop.complications     ?? null,
  }
}

// For UPDATE operations: only include fields explicitly present (and not undefined)
// in the payload. Using mapPreop for updates fills in ?? null / ?? false defaults
// for every missing field, silently wiping existing preop data on any partial or
// stale save (e.g. a replayed offline snapshot). Mirrors mapIntraopUpdate.
export function mapPreopUpdate(preop: Record<string, unknown>) {
  const full = mapPreop(preop)
  const r: Partial<typeof full> = {}
  // "Present" means the key exists AND is not undefined. Form snapshots send
  // undefined for unfilled optional fields, so undefined keys must be skipped.
  const has = (k: string) => k in preop && preop[k] !== undefined

  // Direct fields: source key name === output key name
  const DIRECT = [
      "ageYears", "sex", "heightCm", "weightKg", "bloodType", "rhFactor",
      "teamNotes", "physicalExamReport", "notes", "aiOptIn", "comorbidities",
    "allergies", "latexAllergy", "currentMedications",
    "dentalProsthetics", "looseTeeth", "smoking", "substanceAbuse",
    "bpSystolic", "bpDiastolic", "heartRate", "heartArrhythmia", "spO2", "temperature", "respiratoryRate",
    "bpUnobtainable", "heartRateUnobtainable", "spO2Unobtainable", "temperatureUnobtainable", "respiratoryRateUnobtainable",
    "mallampati", "mouthOpeningCm", "thyromental", "neckMobility",
    "retrognathia", "prominentIncisors", "facialHair", "difficultAirwayNotes", "cormackLehane", "airwayUnobtainable",
    "asaScore", "elective", "emergencySurgery", "highRiskSurgery",
    "rcriIschemicHeart", "rcriCHF", "rcriCVD", "rcriInsulinDM", "rcriCreatinine",
    "rcriScore", "gutaScore", "apfelScore", "stopBangScore",
    "apfelPONVHistory", "apfelPostopOpioids",
    "stopbangSnoring", "stopbangTired", "stopbangObserved", "stopbangBP", "stopbangNeck",
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
  if (has("heightCm") || has("weightKg") || has("bmi")) r.bmi = full.bmi
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

  return r
}

// For UPDATE operations: same partial-update semantics as mapPreopUpdate.
export function mapPostopUpdate(postop: Record<string, unknown>) {
  const full = mapPostop(postop)
  const r: Partial<typeof full> = {}
  const has = (k: string) => k in postop && postop[k] !== undefined

  const DIRECT = [
    "recoveryBpSystolic", "recoveryBpDiastolic", "recoveryHeartRate", "recoverySpO2",
    "painScoreNRS", "ponv", "complications", "handoverItems", "disposition", "dispositionNotes",
    "recoveryBpUnobtainable", "recoveryHeartRateUnobtainable", "recoverySpO2Unobtainable", "recoveryTemperatureUnobtainable",
  ] as const satisfies readonly (keyof typeof full)[]
  for (const k of DIRECT) {
    if (has(k)) copyKey(r, full, k)
  }

  // Aldrete subscores + total — recompute the total whenever any subscore is present
  const aldreteKeys = ["aldreteActivity", "aldreteRespiration", "aldreteCirculation",
    "aldreteConsciousness", "aldreteSpO2", "activityScore", "respirationScore",
    "circulationScore", "consciousnessScore", "spO2Score"]
  if (aldreteKeys.some(has) || has("aldreteTotal")) {
    if (has("aldreteActivity") || has("activityScore"))           r.aldreteActivity      = full.aldreteActivity
    if (has("aldreteRespiration") || has("respirationScore"))     r.aldreteRespiration   = full.aldreteRespiration
    if (has("aldreteCirculation") || has("circulationScore"))     r.aldreteCirculation   = full.aldreteCirculation
    if (has("aldreteConsciousness") || has("consciousnessScore")) r.aldreteConsciousness = full.aldreteConsciousness
    if (has("aldreteSpO2") || has("spO2Score"))                   r.aldreteSpO2          = full.aldreteSpO2
    r.aldreteTotal = full.aldreteTotal
  }

  if (has("temperatureCelsius") || has("temperaturePostop")) r.temperatureCelsius = full.temperatureCelsius

  if (has("disposition") && full.disposition !== "WARD" && full.disposition !== "PACU") {
    r.handoverItems = []
    r.dispositionNotes = null
  }

  return r
}

type PostopRawInput = Partial<Prisma.PostoperativeRecordUncheckedCreateWithoutCaseInput> & {
  activityScore?: unknown
  respirationScore?: unknown
  circulationScore?: unknown
  consciousnessScore?: unknown
  spO2Score?: unknown
  temperaturePostop?: unknown
}

export function mapPostop(rawPostop: Record<string, unknown>): Prisma.PostoperativeRecordUncheckedCreateWithoutCaseInput {
  const postop = canonicalizePostopPatch(rawPostop) as PostopRawInput
  const aldreteActivity = postop.aldreteActivity ?? postop.activityScore
  const aldreteRespiration = postop.aldreteRespiration ?? postop.respirationScore
  const aldreteCirculation = postop.aldreteCirculation ?? postop.circulationScore
  const aldreteConsciousness = postop.aldreteConsciousness ?? postop.consciousnessScore
  const aldreteSpO2 = postop.aldreteSpO2 ?? postop.spO2Score
  const aldreteTotal =
    postop.aldreteTotal != null ? toIntOrNull(postop.aldreteTotal)
    : aldreteActivity != null
      ? [aldreteActivity, aldreteRespiration,
         aldreteCirculation, aldreteConsciousness, aldreteSpO2]
          .reduce((s: number, v: unknown) => s + (parseInt(String(v ?? 0), 10) || 0), 0)
      : null

  return {
    aldreteActivity:      toIntOrNull(aldreteActivity),
    aldreteRespiration:   toIntOrNull(aldreteRespiration),
    aldreteCirculation:   toIntOrNull(aldreteCirculation),
    aldreteConsciousness: toIntOrNull(aldreteConsciousness),
    aldreteSpO2:          toIntOrNull(aldreteSpO2),
    aldreteTotal,
    recoveryBpSystolic:  toIntOrNull(postop.recoveryBpSystolic),
    recoveryBpDiastolic: toIntOrNull(postop.recoveryBpDiastolic),
    recoveryHeartRate:   toIntOrNull(postop.recoveryHeartRate),
    recoverySpO2:        toFloatOrNull(postop.recoverySpO2),
    painScoreNRS:       toIntOrNull(postop.painScoreNRS),
    ponv:               postop.ponv               ?? false,
    temperatureCelsius: toFloatOrNull(postop.temperatureCelsius ?? postop.temperaturePostop),
    recoveryBpUnobtainable:          postop.recoveryBpUnobtainable          ?? false,
    recoveryHeartRateUnobtainable:   postop.recoveryHeartRateUnobtainable   ?? false,
    recoverySpO2Unobtainable:        postop.recoverySpO2Unobtainable        ?? false,
    recoveryTemperatureUnobtainable: postop.recoveryTemperatureUnobtainable ?? false,
    complications:      postop.complications      ?? null,
    handoverItems:      (postop.disposition === "WARD" || postop.disposition === "PACU") ? postop.handoverItems ?? [] : [],
    disposition:        postop.disposition        ?? null,
    dispositionNotes:   (postop.disposition === "WARD" || postop.disposition === "PACU") ? postop.dispositionNotes ?? null : null,
  }
}
