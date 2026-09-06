import { describe, expect, it } from "vitest"

import { mapCasesToOmop } from "@/lib/omop-mapper"

import { completeCaseFixture as completeCase } from "./fixtures/complete-case"

/**
 * The sixteen monitoring flags say a modality was used. These three say what it
 * read, and when -- which is the half a register can pool. A case whose BIS sat
 * at 55 and one that dropped to 22 for twenty minutes are the same case to a
 * boolean, and to a single stored figure they are still nearly the same case.
 * The timestamp is the information.
 */
describe("what the monitors read reaches the export, with its time", () => {
  const options = {
    userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
    excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
  }

  function caseWithReadings(readings: Record<string, unknown>[]) {
    const c = completeCase() as never as { events: unknown[] }
    c.events = readings.map((r, i) => ({
      type: "vital",
      timestamp: new Date(Date.UTC(2026, 5, 1, 9, 40 + i * 5)),
      label: null, value: null, unit: null,
      systolic: null, diastolic: null, heartRate: null,
      spO2: null, etco2: null, temp: null,
      bis: null, tofRatio: null, cvp: null,
      atcCode: null, drugId: null, metadataJson: null,
      ...r,
    }))
    return c
  }

  function rows(bundle: ReturnType<typeof mapCasesToOmop>, source: string) {
    return bundle.measurement.filter(m => m.measurement_source_value === source)
  }

  it("exports one row per BIS reading, each at its own minute", () => {
    const bundle = mapCasesToOmop(
      [caseWithReadings([{ bis: 55 }, { bis: 22 }, { bis: 48 }]) as never],
      options as never,
    )
    const bis = rows(bundle, "LOINC:75918-3")

    expect(bis).toHaveLength(3)
    expect(bis.map(r => r.value_as_number)).toEqual([55, 22, 48])
    // Distinct instants: collapsing them would lose the dip, which is the only
    // reason to record a BIS at all.
    expect(new Set(bis.map(r => r.measurement_datetime)).size).toBe(3)
    expect(bis[0]?.measurement_concept_id).toBe(21490711)
    // The index is dimensionless; no unit concept is borrowed for it.
    expect(bis[0]?.unit_concept_id).toBe(0)
  })

  it("names SNOMED for the train-of-four, which has no LOINC code", () => {
    // 4108453 is the ratio. Claiming a LOINC prefix for a SNOMED code would
    // point a reader at a vocabulary that does not contain it.
    const bundle = mapCasesToOmop([caseWithReadings([{ tofRatio: 0.4 }]) as never], options as never)
    const tof = rows(bundle, "SNOMED:250831000")

    expect(tof).toHaveLength(1)
    expect(tof[0]?.measurement_concept_id).toBe(4108453)
    expect(tof[0]?.value_as_number).toBe(0.4)
    expect(tof[0]?.unit_concept_id).toBe(8523)
  })

  it("exports CVP in mmHg without converting it again", () => {
    // The conversion happens at entry. Converting here as well would make the
    // exported figure depend on whichever unit the clinician had selected.
    const bundle = mapCasesToOmop([caseWithReadings([{ cvp: 7.4 }]) as never], options as never)
    const cvp = rows(bundle, "LOINC:60985-9")

    expect(cvp[0]?.measurement_concept_id).toBe(21490675)
    expect(cvp[0]?.value_as_number).toBe(7.4)
    expect(cvp[0]?.unit_source_value).toBe("mmHg")
  })

  /**
   * The one that would be quietly wrong. A BIS of 0 is an isoelectric EEG and a
   * train-of-four of 0 is a fully paralysed patient. Both are readings somebody
   * charted, and a falsy check anywhere on the path would drop exactly the two
   * values that matter most.
   */
  it("exports a charted zero rather than treating it as nothing", () => {
    const bundle = mapCasesToOmop(
      [caseWithReadings([{ bis: 0, tofRatio: 0 }]) as never],
      options as never,
    )

    expect(rows(bundle, "LOINC:75918-3")[0]?.value_as_number).toBe(0)
    expect(rows(bundle, "SNOMED:250831000")[0]?.value_as_number).toBe(0)
  })

  it("says nothing for a monitor that was used but never charted", () => {
    const bundle = mapCasesToOmop([caseWithReadings([{ bis: 40 }]) as never], options as never)

    expect(rows(bundle, "SNOMED:250831000")).toHaveLength(0)
    expect(rows(bundle, "LOINC:60985-9")).toHaveLength(0)
  })
})
