import { Prisma } from "@/generated/prisma/client"
import { canonicalizePostopPatch } from "@lospor/core/case-payloads"
import { aldreteTotal as coreAldreteTotal } from "@lospor/core/postop"
import { copyKey, safeEnum, toFloatOrNull, toIntOrNull } from "./shared"

export function mapPostopUpdate(postop: Record<string, unknown>) {
  const full = mapPostop(postop)
  const r: Partial<typeof full> = {}
  const has = (k: string) => k in postop && postop[k] !== undefined

  const DIRECT = [
    "recoveryBpSystolic", "recoveryBpDiastolic", "recoveryHeartRate", "recoverySpO2",
    "painScoreNRS", "pediatricPainScale", "pediatricPainScore", "paedScore",
    "ponv", "complications", "handoverItems", "disposition", "dispositionNotes",
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
  // A total is only a total once all five components have been assessed.
  //
  // This used to sum whatever had arrived and count anything missing as 0, so a
  // patient with one component scored — say activity 2, the rest not yet looked
  // at — was recorded with an Aldrete of 2/10. That is not an incomplete score,
  // it is a documented emergency. Core's aldreteTotal returns null until every
  // component is present, which is the same rule the clients and the
  // finalisation gate already use.
  const computedTotal = coreAldreteTotal({
    aldreteActivity:      toIntOrNull(aldreteActivity),
    aldreteRespiration:   toIntOrNull(aldreteRespiration),
    aldreteCirculation:   toIntOrNull(aldreteCirculation),
    aldreteConsciousness: toIntOrNull(aldreteConsciousness),
    aldreteSpO2:          toIntOrNull(aldreteSpO2),
  })
  const aldreteTotal =
    postop.aldreteTotal != null ? toIntOrNull(postop.aldreteTotal) : computedTotal

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
    pediatricPainScale: safeEnum(postop.pediatricPainScale, ["FLACC", "FPS_R", "NRS"] as const),
    pediatricPainScore: toIntOrNull(postop.pediatricPainScore),
    paedScore:          toIntOrNull(postop.paedScore),
    painScoreNRS:       toIntOrNull(postop.painScoreNRS),
    ponv: postop.ponv ?? null,
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
