import { Prisma } from "@/generated/prisma/client"
import { canonicalizePostopPatch } from "@lospor/core/case-payloads"
import { aldreteTotal as coreAldreteTotal, stewardTotal as coreStewardTotal } from "@lospor/core/postop"
import {
  FLACC_FIELDS,
  NIPS_FIELDS,
  PAED_FIELDS,
  flaccTotal as coreFlaccTotal,
  nipsTotal as coreNipsTotal,
  paedTotal as corePaedTotal,
} from "@lospor/core/postop-pain"
import { copyKey, safeEnum, toFloatOrNull, toIntOrNull } from "./shared"

/**
 * The shared payload canonicalizer treats JSON null as Number(null) while it
 * normalizes its derived totals. Null is an explicit clinical "not assessed"
 * value, so repair those totals at the persistence boundary using the shared
 * score functions, which distinguish null from a scored zero.
 */
function correctDerivedTotals(full: Record<string, unknown>): void {
  full.aldreteTotal = coreAldreteTotal({
    aldreteActivity: toIntOrNull(full.aldreteActivity),
    aldreteRespiration: toIntOrNull(full.aldreteRespiration),
    aldreteCirculation: toIntOrNull(full.aldreteCirculation),
    aldreteConsciousness: toIntOrNull(full.aldreteConsciousness),
    aldreteSpO2: toIntOrNull(full.aldreteSpO2),
  })
  full.stewardTotal = coreStewardTotal({
    stewardConsciousness: toIntOrNull(full.stewardConsciousness),
    stewardAirway: toIntOrNull(full.stewardAirway),
    stewardMovement: toIntOrNull(full.stewardMovement),
  })
  full.flaccTotal = coreFlaccTotal(Object.fromEntries(FLACC_FIELDS.map(key => [key, toIntOrNull(full[key])])) as Record<typeof FLACC_FIELDS[number], number | null>)
  full.nipsTotal = coreNipsTotal(Object.fromEntries(NIPS_FIELDS.map(key => [key, toIntOrNull(full[key])])) as Record<typeof NIPS_FIELDS[number], number | null>)
  full.paedScore = corePaedTotal(Object.fromEntries(PAED_FIELDS.map(key => [key, toIntOrNull(full[key])])) as Record<typeof PAED_FIELDS[number], number | null>)
}

export function mapPostopUpdate(
  postop: Record<string, unknown>,
  existingPostop: Record<string, unknown> = {},
) {
  // Derived totals are calculated from the complete post-op state, not only
  // the fields in this PATCH. The clients save section fields incrementally;
  // calculating from the patch alone would clear a previously complete FLACC,
  // NIPS, Aldrete, or Steward total whenever the next edit touched one item.
  const full = mapPostop({ ...existingPostop, ...postop })
  correctDerivedTotals(full as unknown as Record<string, unknown>)
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

  // A child's Steward score: the same rule, three components.
  const stewardKeys = ["stewardConsciousness", "stewardAirway", "stewardMovement"] as const
  if (stewardKeys.some(has) || has("stewardTotal")) {
    for (const key of stewardKeys) if (has(key)) r[key] = full[key]
    r.stewardTotal = full.stewardTotal
  }

  // Item-scored pain and delirium (10.0.0): each total follows its items.
  for (const [fields, total] of [[FLACC_FIELDS, "flaccTotal"], [NIPS_FIELDS, "nipsTotal"], [PAED_FIELDS, "paedScore"]] as const) {
    if (!fields.some(has)) continue
    for (const key of fields) if (has(key)) r[key] = full[key]
    r[total] = full[total]
  }
  if (has("fpsrScore")) r.fpsrScore = full.fpsrScore

  if (has("temperatureCelsius") || has("temperaturePostop")) r.temperatureCelsius = full.temperatureCelsius
  if (has("performedProcedures")) r.performedProceduresJson = full.performedProceduresJson

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
  const performedProcedures = Array.isArray(rawPostop.performedProcedures) ? rawPostop.performedProcedures : []
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
  const steward = {
    stewardConsciousness: toIntOrNull(postop.stewardConsciousness),
    stewardAirway:        toIntOrNull(postop.stewardAirway),
    stewardMovement:      toIntOrNull(postop.stewardMovement),
  }
  const stewardTotal = postop.stewardTotal != null ? toIntOrNull(postop.stewardTotal) : coreStewardTotal(steward)

  const mapped = {
    aldreteActivity:      toIntOrNull(aldreteActivity),
    aldreteRespiration:   toIntOrNull(aldreteRespiration),
    aldreteCirculation:   toIntOrNull(aldreteCirculation),
    aldreteConsciousness: toIntOrNull(aldreteConsciousness),
    aldreteSpO2:          toIntOrNull(aldreteSpO2),
    aldreteTotal,
    ...steward,
    stewardTotal,
    recoveryBpSystolic:  toIntOrNull(postop.recoveryBpSystolic),
    recoveryBpDiastolic: toIntOrNull(postop.recoveryBpDiastolic),
    recoveryHeartRate:   toIntOrNull(postop.recoveryHeartRate),
    recoverySpO2:        toFloatOrNull(postop.recoverySpO2),
    pediatricPainScale: safeEnum(postop.pediatricPainScale, ["FLACC", "FPS_R", "NRS"] as const),
    pediatricPainScore: toIntOrNull(postop.pediatricPainScore),
    paedScore:          toIntOrNull(postop.paedScore),
    flaccFace:          toIntOrNull(postop.flaccFace),
    flaccLegs:          toIntOrNull(postop.flaccLegs),
    flaccActivity:      toIntOrNull(postop.flaccActivity),
    flaccCry:           toIntOrNull(postop.flaccCry),
    flaccConsolability: toIntOrNull(postop.flaccConsolability),
    fpsrScore:          toIntOrNull(postop.fpsrScore),
    nipsFacialExpression:toIntOrNull(postop.nipsFacialExpression),
    nipsCry:            toIntOrNull(postop.nipsCry),
    nipsBreathing:      toIntOrNull(postop.nipsBreathing),
    nipsArms:           toIntOrNull(postop.nipsArms),
    nipsLegs:           toIntOrNull(postop.nipsLegs),
    nipsArousal:        toIntOrNull(postop.nipsArousal),
    paedEyeContact:     toIntOrNull(postop.paedEyeContact),
    paedPurposeful:     toIntOrNull(postop.paedPurposeful),
    paedAware:          toIntOrNull(postop.paedAware),
    paedRestless:       toIntOrNull(postop.paedRestless),
    paedInconsolable:   toIntOrNull(postop.paedInconsolable),
    flaccTotal:         toIntOrNull(postop.flaccTotal),
    nipsTotal:          toIntOrNull(postop.nipsTotal),
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
    // The procedure done (10.0.0), as the planned procedures are kept.
    performedProceduresJson: performedProcedures.length > 0 ? performedProcedures as Prisma.InputJsonValue : Prisma.JsonNull,
  }
  correctDerivedTotals(mapped as unknown as Record<string, unknown>)
  return mapped
}
