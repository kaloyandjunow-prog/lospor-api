import { describe, expect, it } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"

import { completeCaseFixture } from "./fixtures/complete-case"

// A measurement the anaesthetist attempted and could not obtain is a finding
// about the patient — unobtainable readings cluster in shocked, arrhythmic and
// peripherally shut-down patients. Exported as an absent row it becomes
// indistinguishable from a documentation gap, and any downstream imputation
// then invents a plausible number for a patient whose finding was that no
// number existed. That biases exactly the sickest cases towards looking safer.
//
// SNOMED 876785008 "Unobtainable" is a Meas Value qualifier, so it belongs in
// measurement.value_as_concept_id beside a null value_as_number: "this was
// measured; the result was unobtainable."

const UNOBTAINABLE = 618772
const MALLAMPATI_NOT_ASSESSABLE = 4309852

const OPTIONS = {
  userId: "admin-1",
  userRole: "ADMIN" as const,
  statusFilter: ["COMPLETE"],
  excludedCaseCount: 0,
  gitCommit: "test",
  forcedOverride: false,
}

function exportWith(section: "preop" | "postop", fields: Record<string, unknown>) {
  const record = completeCaseFixture() as Record<string, unknown>
  record[section] = { ...(record[section] as Record<string, unknown>), ...fields }
  return mapCasesToOmop([record as never], OPTIONS)
}

function measured(bundle: ReturnType<typeof mapCasesToOmop>, source: string) {
  return bundle.measurement.filter(row => row.measurement_source_value === source)
}

/**
 * Preoperative vitals and intraoperative event vitals share a LOINC source
 * value and are told apart only by date, so assertions about the preoperative
 * reading select on the qualifier rather than the code.
 */
function unobtainable(bundle: ReturnType<typeof mapCasesToOmop>, source: string) {
  return measured(bundle, source).filter(row => row.value_as_concept_id != null)
}

describe("a vital that could not be obtained is exported as such", () => {
  it("emits the measurement with the Unobtainable qualifier instead of nothing", () => {
    const bundle = exportWith("preop", { heartRate: null, heartRateUnobtainable: true })
    const rows = unobtainable(bundle, "LOINC:8867-4")

    expect(rows).toHaveLength(1)
    expect(rows[0].value_as_number).toBeNull()
    expect(rows[0].value_as_concept_id).toBe(UNOBTAINABLE)
    // Still recognisably a heart rate, so it is found by a query for one.
    expect(rows[0].measurement_concept_id).toBe(3027018)
  })

  it("qualifies both halves of a blood pressure from the single flag", () => {
    // One tickbox covers systolic and diastolic, because a pressure that could
    // not be obtained is neither.
    const bundle = exportWith("preop", {
      bpSystolic: null, bpDiastolic: null, bpUnobtainable: true,
    })

    for (const loinc of ["LOINC:8480-6", "LOINC:8462-4"]) {
      const rows = unobtainable(bundle, loinc)
      expect(rows, loinc).toHaveLength(1)
      expect(rows[0].value_as_concept_id, loinc).toBe(UNOBTAINABLE)
    }
  })

  it("still emits nothing when the reading was simply never recorded", () => {
    const bundle = exportWith("preop", { heartRate: null, heartRateUnobtainable: false })

    expect(unobtainable(bundle, "LOINC:8867-4")).toEqual([])
  })

  it("prefers a recorded value over the flag", () => {
    // If a number is present the measurement was obtained, whatever the
    // tickbox says — the value is the stronger evidence.
    const bundle = exportWith("preop", { heartRate: 72, heartRateUnobtainable: true })

    expect(unobtainable(bundle, "LOINC:8867-4")).toEqual([])
    expect(measured(bundle, "LOINC:8867-4").map(row => row.value_as_number)).toContain(72)
  })

  it("carries the same qualifier for recovery vitals", () => {
    const bundle = exportWith("postop", {
      recoverySpO2: null, recoverySpO2Unobtainable: true,
    })
    const rows = measured(bundle, "POSTOP_LOINC:59408-5")

    expect(rows).toHaveLength(1)
    expect(rows[0].value_as_concept_id).toBe(UNOBTAINABLE)
  })
})

describe("an airway that could not be assessed is exported as such", () => {
  it("uses the dedicated not-assessable concept for Mallampati", () => {
    // SNOMED has a concept for precisely this, and it is more specific than the
    // generic qualifier: the score is what could not be assessed.
    const bundle = exportWith("preop", { mallampati: null, airwayUnobtainable: true })
    const rows = measured(bundle, "LOSPOR:MALLAMPATI")

    expect(rows).toHaveLength(1)
    expect(rows[0].value_as_concept_id).toBe(MALLAMPATI_NOT_ASSESSABLE)
  })

  it("qualifies the airway distances from the same single flag", () => {
    const bundle = exportWith("preop", {
      mouthOpeningCm: null, thyromental: null, airwayUnobtainable: true,
    })

    for (const source of ["LOSPOR:MOUTH_OPENING_CM", "LOSPOR:THYROMENTAL_DISTANCE_CM"]) {
      const rows = measured(bundle, source)
      expect(rows, source).toHaveLength(1)
      expect(rows[0].value_as_number, source).toBeNull()
      expect(rows[0].value_as_concept_id, source).toBe(UNOBTAINABLE)
    }
  })

  it("grades Mallampati as a coded answer when it was assessed", () => {
    const bundle = exportWith("preop", { mallampati: "II" })
    const rows = measured(bundle, "LOSPOR:MALLAMPATI")

    expect(rows[0].measurement_concept_id).toBe(4165278)
    expect(rows[0].value_as_concept_id).toBe(4313490)
    expect(rows[0].value_source_value).toBe("II")
  })
})
