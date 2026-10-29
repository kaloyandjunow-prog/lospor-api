import { describe, expect, it } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"
import { mapPostop, mapPostopUpdate } from "@/app/v1/cases/_mappers/postop"
import { postopSchema } from "@/lib/schemas/case"
import { pediatricCaseFixture as pediatricCase } from "./fixtures/pediatric-case"

const FLACC = { flaccFace: 1, flaccLegs: 0, flaccActivity: 2, flaccCry: 1, flaccConsolability: 1 }
const NIPS = { nipsFacialExpression: 1, nipsCry: 2, nipsBreathing: 0, nipsArms: 1, nipsLegs: 0, nipsArousal: 1 }
const PAED = { paedEyeContact: 3, paedPurposeful: 2, paedAware: 2, paedRestless: 1, paedInconsolable: 0 }

describe("item-scored postop pain and delirium (10.0.0)", () => {
  it("stores every item with its total", () => {
    const row = mapPostop({ ...FLACC, ...NIPS, ...PAED, fpsrScore: 4 })
    expect(row).toMatchObject({ ...FLACC, flaccTotal: 5, ...NIPS, nipsTotal: 5, ...PAED, paedScore: 8, fpsrScore: 4 })
  })

  it("updates a total with its items, and clears it when they are incomplete", () => {
    expect(mapPostopUpdate({ ...FLACC })).toMatchObject({ flaccTotal: 5 })
    expect(mapPostopUpdate({ flaccFace: 2 })).toMatchObject({ flaccFace: 2, flaccTotal: null })
    expect(mapPostopUpdate({ fpsrScore: 6 })).toEqual({ fpsrScore: 6 })
  })

  it("recomputes an item total with the existing items during a partial edit", () => {
    expect(mapPostopUpdate({ flaccFace: 2 }, { ...FLACC, flaccTotal: 5 })).toMatchObject({
      flaccFace: 2,
      flaccTotal: 6,
    })
  })

  it("refuses an item out of range and an FPS-R between faces", () => {
    expect(postopSchema.safeParse({ nipsBreathing: 2 }).success).toBe(false)
    expect(postopSchema.safeParse({ paedRestless: 5 }).success).toBe(false)
    expect(postopSchema.safeParse({ fpsrScore: 3 }).success).toBe(false)
    expect(postopSchema.safeParse({ fpsrScore: 8 }).success).toBe(true)
  })

  it("exports the items and totals to OMOP", () => {
    const fixture = pediatricCase()
    const bundle = mapCasesToOmop([{ ...fixture, postop: { ...fixture.postop!, ...FLACC, flaccTotal: 5, ...NIPS, nipsTotal: 5, ...PAED, fpsrScore: 4 } }])
    const measurements = new Map(bundle.measurement.map(row => [row.measurement_source_value, row]))
    const observations = new Map(bundle.observation.map(row => [row.observation_source_value, row]))
    expect(measurements.get("LOINC:38215-0")).toMatchObject({ measurement_concept_id: 3036118, value_as_number: 5 })
    expect(measurements.get("LOINC:98012-8")).toMatchObject({ measurement_concept_id: 1617629, value_as_number: 5 })
    expect(observations.get("LOINC:38218-4")).toMatchObject({ observation_concept_id: 3037008, value_as_number: 2 })
    expect(observations.get("LOSPOR:FPS_R")).toMatchObject({ observation_concept_id: 40760807, value_as_number: 4 })
    expect(observations.get("LOSPOR:NIPS_CRY")).toMatchObject({ observation_concept_id: 0, value_as_number: 2 })
    expect(observations.get("LOSPOR:PAED_EYE_CONTACT")).toMatchObject({ observation_concept_id: 0, value_as_number: 3 })
  })
})
