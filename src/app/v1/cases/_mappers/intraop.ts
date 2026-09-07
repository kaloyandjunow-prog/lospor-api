import { Prisma } from "@/generated/prisma/client"
import {
  durationMinutesBetween,
  endInstantForWallClock,
  instantFromLocalTime,
  isValidTimeZone,
} from "@/lib/intraop-time"
import { canonicalizeIntraopPatch } from "@lospor/core/case-payloads"
import { normalizeOptionCodes } from "@lospor/core/option-aliases"
import { copyKey, safeEnum, toFloatOrNull, toIntOrNull } from "./shared"

/** A bare wall clock, the only shape the legacy startTime/endTime columns accept. */
const HHMMRE = /^([01]\d|2[0-3]):([0-5]\d)$/

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
    "presentsIntubated","airwayNotApplicable",
    "lmaSize","oralTubeSize","oralCuffed","nasalTubeSize","nasalCuffed",
    "dltType","dltSide","dltSize","endobronchialSize",
    "volatileAgent",

    "ecg","urinaryCatheter","stomachTube","spO2Monitor","invasiveBP","cvpMonitor",
    "neuroMonitor","nbpMonitor","etco2Monitor",
    "tempMonitor","paCatheter","tee","bis","entropyMonitor","nirsMonitor",
    "evokedPotentials","tofMonitor",
    "vascularAccesses","premedicationEvening","premedicationMorning","drugsAdministered",
    // crystalloidsMl/colloidsMl/bloodMl are intentionally NOT accepted here:
    // they are derived from the fluid events and written server-side in
    // rebuildProjection (case-events.ts), so a client PATCH can't override the
    // single source of truth. The read path (below) still returns them.
    "bloodProductsNote","urineMl","bloodLossMl","labResults","complications",
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
    presentsIntubated:   intraop.presentsIntubated   ?? false,
    airwayNotApplicable: intraop.airwayNotApplicable ?? false,
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
    ecg:              intraop.ecg              ?? false,
    urinaryCatheter:  intraop.urinaryCatheter  ?? false,
    stomachTube:      intraop.stomachTube      ?? false,
    spO2Monitor:      intraop.spO2Monitor      ?? true,
    invasiveBP:       intraop.invasiveBP       ?? false,
    cvpMonitor:       intraop.cvpMonitor       ?? false,
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
    bloodLossMl:       intraop.bloodLossMl       ?? null,
    labResults:        intraop.labResults        ?? [],
    complications:     intraop.complications     ?? null,
  }
}

// For UPDATE operations: only include fields explicitly present (and not undefined)
// in the payload. Using mapPreop for updates fills in ?? null / ?? false defaults
// for every missing field, silently wiping existing preop data on any partial or
// stale save (e.g. a replayed offline snapshot). Mirrors mapIntraopUpdate.
