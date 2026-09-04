import { describe, expect, it } from "vitest"

import { mapCasesToOmop } from "@/lib/omop-mapper"

import { completeCaseFixture as completeCase } from "./fixtures/complete-case"

/**
 * The sixteen monitoring flags say a modality was used. They cannot say what it
 * showed, and for these three that is the whole clinical question: a BIS that
 * sat at 55 and one that dropped to 22 for twenty minutes are the same case to
 * a boolean, as are a train-of-four of 0.9 and one of 0.4 at extubation.
 */
describe("what the monitors read reaches the export", () => {
  const options = {
    userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
    excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
  }

  function caseWith(values: Record<string, unknown>) {
    const c = completeCase() as never as { intraop: Record<string, unknown> }
    Object.assign(c.intraop, values)
    return c
  }

  function measurement(bundle: ReturnType<typeof mapCasesToOmop>, source: string) {
    return bundle.measurement.find(m => m.measurement_source_value === source)
  }

  it("exports the bispectral index as a measurement, not an observation", () => {
    // Measurement domain is the vocabulary's own classification for all three,
    // so they belong in MEASUREMENT rather than beside the flags.
    const bundle = mapCasesToOmop([caseWith({ bis: true, bisValue: 38 }) as never], options as never)
    const row = measurement(bundle, "LOSPOR:BIS_VALUE")

    expect(row).toBeDefined()
    expect(row?.measurement_concept_id).toBe(4134573)
    expect(row?.value_as_number).toBe(38)
    // Dimensionless. Borrowing a plausible unit concept would assert something
    // the index does not have.
    expect(row?.unit_concept_id).toBe(0)
  })

  it("exports the train-of-four under the ratio's concept, not the count's", () => {
    // 4353950 is the count and is a different measurement. The field takes only
    // the ratio, so exporting under the count would misstate what was recorded.
    const bundle = mapCasesToOmop([caseWith({ tofMonitor: true, tofRatio: 0.4 }) as never], options as never)
    const row = measurement(bundle, "LOSPOR:TOF_RATIO")

    expect(row?.measurement_concept_id).toBe(4108453)
    expect(row?.value_as_number).toBe(0.4)
    expect(row?.unit_concept_id).toBe(8523)
  })

  /**
   * The one that would be silently wrong. CVP is entered in cmH2O by default
   * and stored in mmHg, and the conversion happens at entry. If the export
   * converted instead, the exported number would depend on whatever unit the
   * clinician happened to have selected -- so a value already in mmHg must
   * leave untouched.
   */
  it("exports CVP in mmHg without converting it again", () => {
    const bundle = mapCasesToOmop([caseWith({ cvpMonitor: true, cvpMmHg: 7.4 }) as never], options as never)
    const row = measurement(bundle, "LOSPOR:CVP_MMHG")

    expect(row?.measurement_concept_id).toBe(4323687)
    expect(row?.value_as_number).toBe(7.4)
    expect(row?.unit_concept_id).toBe(8876)
    expect(row?.unit_source_value).toBe("mmHg")
  })

  it("says nothing when a monitor was used but no value was charted", () => {
    // A common and honest record: the monitor was on, nobody wrote a number
    // down. The flag still exports; the measurement must not, because a 0 here
    // would read as an isoelectric EEG.
    const bundle = mapCasesToOmop([caseWith({ bis: true, bisValue: null }) as never], options as never)

    expect(measurement(bundle, "LOSPOR:BIS_VALUE")).toBeUndefined()
  })

  it("exports a genuine zero rather than dropping it", () => {
    // The other half, and the reason the column is nullable rather than
    // defaulted: a train-of-four of 0 is a fully paralysed patient, which is a
    // reading, not a blank.
    const bundle = mapCasesToOmop([caseWith({ tofMonitor: true, tofRatio: 0 }) as never], options as never)

    expect(measurement(bundle, "LOSPOR:TOF_RATIO")?.value_as_number).toBe(0)
  })
})
