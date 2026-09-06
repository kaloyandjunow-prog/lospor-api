import { beforeEach, describe, expect, it, vi } from "vitest"
import { INTRAOP_DRUG_CODE_ENTRIES } from "@lospor/core/catalog"
import { mapCasesToOmop } from "@/lib/omop-mapper"
import { completeCaseFixture } from "./fixtures/complete-case"

// The concepts these ATC codes resolve to in the OMOP standard vocabulary, as
// read from the local Athena snapshot. Only the codes the tests below assert
// on: a fake that answered for every code would prove nothing about whether
// the right one was asked for.
const ATHENA = {
  N01AX10: { conceptId: 753626, label: "propofol" },
  N01AB08: { conceptId: 19039298, label: "sevoflurane" },
  B05AA07: { conceptId: 19077117, label: "hetastarch" },
  B05BC01: { conceptId: 994058, label: "mannitol" },
  M03AC09: { conceptId: 19003953, label: "rocuronium" },
} as const

// B05BB01 (electrolytes) is a real ATC code with no standard OMOP concept
// behind it today. It is seeded, and it is in the map, but SOURCE_ONLY.
const SOURCE_ONLY_CODES = ["B05BB01"]

function makeDb() {
  return {
    conceptMap: {
      findMany: vi.fn().mockResolvedValue([
        ...Object.entries(ATHENA).map(([sourceCode, concept]) => ({
          domain: "drug",
          sourceVocabulary: "ATC",
          sourceCode,
          standardConceptId: concept.conceptId,
          mappingStatus: "MAPPED",
        })),
        ...SOURCE_ONLY_CODES.map(sourceCode => ({
          domain: "drug",
          sourceVocabulary: "ATC",
          sourceCode,
          standardConceptId: null,
          mappingStatus: "SOURCE_ONLY",
        })),
      ]),
    },
  }
}

async function resolve(events: Record<string, unknown>[]) {
  // Fresh module instance: relational-sync caches the concept map for the life
  // of the process, which is right in a server and wrong across tests.
  vi.resetModules()
  const { resolveDrugExposureConcepts } = await import("@/lib/relational-sync")
  await resolveDrugExposureConcepts(makeDb() as never, events)
  return events
}

describe("intraoperative drug concepts", () => {
  beforeEach(() => { vi.resetModules() })

  it("codes a drug the client sent no ATC code for", async () => {
    // What every client sent before the catalogs carried codes, and what the
    // fluid and volatile-agent surfaces still send today.
    const [propofol] = await resolve([
      { type: "drug", name: "Propofol", dose: "200", unit: "mg" },
    ])
    expect(propofol.atcCode).toBe("N01AX10")
    expect(propofol.standardConceptId).toBe(753626)
    expect(propofol.mappingStatus).toBe("MAPPED")
  })

  it("codes an inhalational agent and an intravenous fluid, which nothing ever did", async () => {
    const [sevoflurane, hes] = await resolve([
      { type: "agent_start", name: "Sevoflurane", value: "2" },
      { type: "fluid_start", name: "HES", volume: 500, category: "Colloids" },
    ])
    expect(sevoflurane.atcCode).toBe("N01AB08")
    expect(sevoflurane.standardConceptId).toBe(19039298)
    expect(hes.atcCode).toBe("B05AA07")
    expect(hes.standardConceptId).toBe(19077117)
  })

  it("keeps a code the client did send", async () => {
    // A client reading the option library sends the code itself. The lookup
    // must not second-guess it, or the two paths could disagree.
    const [rocuronium] = await resolve([
      { type: "drug", name: "Rocuronium", atcCode: "M03AC09" },
    ])
    expect(rocuronium.atcCode).toBe("M03AC09")
    expect(rocuronium.standardConceptId).toBe(19003953)
  })

  it("reads through the concentration the web timetable appends to an infusion", async () => {
    const [infusion] = await resolve([
      { type: "infusion_start", name: "Propofol 1%", rate: "6", unit: "mg/kg/h" },
    ])
    expect(infusion.atcCode).toBe("N01AX10")
    expect(infusion.standardConceptId).toBe(753626)
  })

  it("gives a bolus and an infusion of one drug the same concept", async () => {
    const [bolus, infusion] = await resolve([
      { type: "drug", name: "Propofol", dose: "200" },
      { type: "infusion_start", name: "Propofol", rate: "6" },
    ])
    expect(infusion.atcCode).toBe(bolus.atcCode)
    expect(infusion.standardConceptId).toBe(bolus.standardConceptId)
  })

  it("records a real code with no concept behind it as source-only, not as mapped", async () => {
    // Hartmann's is B05BB01, which is correct and which OMOP has no standard
    // concept for. The honest export says so; it does not reach for a
    // neighbouring code that happens to have one.
    const [hartmanns] = await resolve([
      { type: "fluid_start", name: "Lactated Ringer's / Hartmann's", volume: 1000 },
    ])
    expect(hartmanns.atcCode).toBe("B05BB01")
    expect(hartmanns.standardConceptId).toBeNull()
    expect(hartmanns.mappingStatus).toBe("SOURCE_ONLY")
  })

  it("leaves a drug it does not recognise uncoded rather than guessing", async () => {
    const [freeText, wholeBlood] = await resolve([
      { type: "drug", name: "Something the catalog has never heard of" },
      // A catalog entry that deliberately has no ATC code at all.
      { type: "fluid_start", name: "Whole blood", volume: 450 },
    ])
    expect(freeText.atcCode).toBeUndefined()
    expect(freeText.standardConceptId).toBeNull()
    expect(wholeBlood.atcCode).toBeUndefined()
    expect(wholeBlood.standardConceptId).toBeNull()
  })

  it("does not touch events that are not administrations", async () => {
    const [vital, stop] = await resolve([
      { type: "vital", heartRate: 70 },
      { type: "infusion_stop", name: "Propofol", infId: "inf-1" },
    ])
    expect(vital.standardConceptId).toBeUndefined()
    expect(stop.standardConceptId).toBeUndefined()
  })

  it("carries the resolved concept into the OMOP drug_exposure rows", async () => {
    // The end of the chain: what a researcher actually downloads. The fixture
    // stores the volatile agent and the fluid the way they were stored before
    // this change — no concept at all — so this exercises the resolution and
    // the export together rather than a pre-filled fixture value.
    const events: Record<string, unknown>[] = [
      { type: "drug", name: "Propofol", dose: "200", unit: "mg" },
      { type: "agent_start", name: "Sevoflurane", value: "2" },
      { type: "fluid_start", name: "Mannitol", volume: 250 },
    ]
    await resolve(events)

    const fixture = completeCaseFixture() as unknown as {
      events: Record<string, unknown>[]
    }
    fixture.events = events.map((event, index) => ({
      type: event.type,
      timestamp: new Date(`2026-06-01T08:${20 + index}:00Z`),
      label: event.name,
      value: null,
      unit: event.type === "agent_start" ? "%" : "mg",
      volume: event.volume ?? null,
      atcCode: event.atcCode ?? null,
      standardConceptId: event.standardConceptId ?? null,
      mappingStatus: event.mappingStatus ?? "SOURCE_ONLY",
      metadataJson: { name: event.name, dose: event.dose },
    }))

    const bundle = mapCasesToOmop([fixture as never], {
      userId: "admin-1",
      userRole: "ADMIN",
      statusFilter: ["COMPLETE"],
      excludedCaseCount: 0,
      gitCommit: "test",
      forcedOverride: false,
    })

    const drugRow = (needle: string) =>
      bundle.drug_exposure.find(row => String(row.drug_source_value).includes(needle))

    expect(drugRow("Propofol")?.drug_concept_id).toBe(753626)
    expect(drugRow("Sevoflurane")?.drug_concept_id).toBe(19039298)
    expect(drugRow("Mannitol")?.drug_concept_id).toBe(994058)
    // The source code travels alongside the concept, so an unmapped row is
    // still identifiable and a mapped one is still checkable. INTRAOP: is what
    // tells this row apart from the same drug given as a premedication --
    // drug_type_concept_id alone cannot, since both are 32818 (EHR
    // administration record); the vocabulary has nothing for clinical phase.
    expect(drugRow("Sevoflurane")?.drug_source_value).toBe("INTRAOP:ATC:N01AB08 - Sevoflurane")
    expect(drugRow("Sevoflurane")?.drug_type_concept_id).toBe(32818)
    // None of the three exports as the old unconditional zero. The preop
    // medication rows in the same bundle are left alone: they were never the
    // broken half.
    for (const name of ["Propofol", "Sevoflurane", "Mannitol"]) {
      expect(drugRow(name)?.drug_concept_id, name).not.toBe(0)
    }
  })

  it("has a code for every catalog drug except the three with none", async () => {
    // The list itself is the deliverable. This is what stops a new drug being
    // added to a catalog without anyone looking up its code.
    const uncoded = INTRAOP_DRUG_CODE_ENTRIES.filter(entry => !entry.atcCode)
    expect(uncoded.map(entry => entry.name).sort()).toEqual([
      "Cell salvage / autologous blood",
      "Cryoprecipitate",
      "Whole blood",
    ])
    expect(INTRAOP_DRUG_CODE_ENTRIES.length).toBeGreaterThan(200)
  })
})
