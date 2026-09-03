import { describe, expect, it } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"

import { completeCaseFixture } from "./fixtures/complete-case"

// What a clinician recorded has to survive into the export with its meaning
// intact. For a fluid figure there are three distinct clinical statements and
// they must not collapse into each other:
//
//   not recorded   -> no observation row
//   recorded as 0  -> a row carrying 0
//   recorded as N  -> a row carrying N
//
// A null that exported as 0 would invent a measurement; a 0 that exported as
// nothing would discard one. Both are silent in a research dataset, which is
// why this is pinned here rather than left to the mapper's null guard.

const OPTIONS = {
  userId: "admin-1",
  userRole: "ADMIN" as const,
  statusFilter: ["COMPLETE"],
  excludedCaseCount: 0,
  gitCommit: "test",
  forcedOverride: false,
}

function exportWithIntraop(fields: Record<string, unknown>) {
  const record = completeCaseFixture() as Record<string, unknown>
  record.intraop = { ...(record.intraop as Record<string, unknown>), ...fields }
  return mapCasesToOmop([record as never], OPTIONS)
}

function observation(bundle: ReturnType<typeof mapCasesToOmop>, source: string) {
  return bundle.observation.filter(row => row.observation_source_value === source)
}

// Urine output is a Measurement-domain concept (3014315) and so lives in
// MEASUREMENT, while the other fluid figures have no concept and stay
// observations. The three-state guarantee is identical either way, so these
// tests look the value up wherever its concept says it belongs rather than
// assuming one table.
function measurement(bundle: ReturnType<typeof mapCasesToOmop>, source: string) {
  return bundle.measurement.filter(row => row.measurement_source_value === source)
}

const rowsFor = (bundle: ReturnType<typeof mapCasesToOmop>, source: string) =>
  source === "LOSPOR:URINE_OUTPUT_ML"
    ? measurement(bundle, source).map(r => ({ value_as_number: r.value_as_number }))
    : observation(bundle, source).map(r => ({ value_as_number: r.value_as_number }))

describe("fluid figures reach the OMOP export", () => {
  it("emits blood loss as its own observation", () => {
    // Guards the wiring itself: blood loss was added to the record, the
    // mappers and the dictionary, and nothing asserted it actually leaves the
    // building. A passing suite meant "nothing broke", not "this is exported".
    const rows = observation(exportWithIntraop({ bloodLossMl: 250 }), "LOSPOR:BLOOD_LOSS_ML")

    expect(rows).toHaveLength(1)
    expect(rows[0].value_as_number).toBe(250)
    expect(rows[0].value_as_string).toBe("250")
  })

  it("emits urine output as its own measurement", () => {
    // Moved from observation once it gained concept 3014315, whose domain is
    // Measurement. The row still has to exist and still has to carry 400.
    const rows = measurement(exportWithIntraop({ urineMl: 400 }), "LOSPOR:URINE_OUTPUT_ML")

    expect(rows).toHaveLength(1)
    expect(rows[0].value_as_number).toBe(400)
    expect(rows[0].measurement_concept_id).toBe(3014315)
  })

  it.each([
    ["LOSPOR:BLOOD_LOSS_ML", "bloodLossMl"],
    ["LOSPOR:URINE_OUTPUT_ML", "urineMl"],
    ["LOSPOR:CRYSTALLOIDS_ML", "crystalloidsMl"],
  ])("%s carries a recorded zero rather than dropping it", (source, field) => {
    const rows = rowsFor(exportWithIntraop({ [field]: 0 }), source)

    expect(rows).toHaveLength(1)
    expect(rows[0].value_as_number).toBe(0)
  })

  it.each([
    ["LOSPOR:BLOOD_LOSS_ML", "bloodLossMl"],
    ["LOSPOR:URINE_OUTPUT_ML", "urineMl"],
    ["LOSPOR:CRYSTALLOIDS_ML", "crystalloidsMl"],
  ])("%s emits nothing when the figure was never recorded", (source, field) => {
    expect(rowsFor(exportWithIntraop({ [field]: null }), source)).toEqual([])
  })

  it("keeps a recorded zero and a blank apart in the same export", () => {
    const bundle = exportWithIntraop({ bloodLossMl: 0, urineMl: null })

    expect(observation(bundle, "LOSPOR:BLOOD_LOSS_ML")).toHaveLength(1)
    expect(measurement(bundle, "LOSPOR:URINE_OUTPUT_ML")).toEqual([])
  })
})

// A vital the anaesthetist tried and could not obtain is a third state, and a
// clinically different one from "nobody recorded it". The appliance does hold
// that distinction: relational-sync writes the vital as "not-applicable" when
// its unobtainable flag is set, which lands as NOT_APPLICABLE in
// ClinicalFieldStatus rather than NOT_DOCUMENTED.
//
// It does not reach the export. ClinicalFieldStatus is read by the mapper only
// to count cases missing field-status rows for the quality gate; no row of it
// enters the bundle, and there is no observation for the flags themselves. So
// downstream — including Central, which receives this bundle — an unobtainable
// blood pressure is indistinguishable from one nobody attempted.
//
// Pinned as the current behaviour, not endorsed as correct. If the flags are
// later exported, this test should fail and be rewritten to assert that.
describe("unobtainable vitals do not currently reach the export", () => {
  it("emits no observation for a vital marked unobtainable", () => {
    const record = completeCaseFixture() as Record<string, unknown>
    record.preop = {
      ...(record.preop as Record<string, unknown>),
      bpSystolic: null,
      bpDiastolic: null,
      bpUnobtainable: true,
    }
    const bundle = mapCasesToOmop([record as never], OPTIONS)

    const unobtainableRows = bundle.observation.filter(row =>
      String(row.observation_source_value).toUpperCase().includes("UNOBTAINABLE"))

    expect(unobtainableRows).toEqual([])
  })
})
