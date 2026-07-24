import { describe, it, expect } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"

type AnyCase = Parameters<typeof mapCasesToOmop>[0][number]

const makeCase = (over: Partial<AnyCase> = {}): AnyCase => ({
  id: "case-1",
  caseCode: "2026-0001",
  createdAt: new Date("2026-03-04T08:00:00Z"),
  status: "COMPLETE",
  preop: { ageYears: 64, sex: "MALE" },
  intraop: { startTime: new Date("2026-03-04T09:00:00Z"), endTime: new Date("2026-03-04T11:30:00Z") },
  ...over,
} as AnyCase)

describe("OMOP person + observation_period", () => {
  it("emits a PERSON row per case — the root every clinical row references", () => {
    const b = mapCasesToOmop([makeCase()])
    expect(b.person).toHaveLength(1)
    expect(b.person[0].person_id).toBe(b.visit_occurrence[0].person_id)
  })

  it("emits an OBSERVATION_PERIOD spanning the operation", () => {
    const b = mapCasesToOmop([makeCase()])
    expect(b.observation_period).toHaveLength(1)
    const op = b.observation_period[0]
    expect(op.person_id).toBe(b.person[0].person_id)
    expect(op.observation_period_start_date).toBe("2026-03-04")
    expect(op.observation_period_end_date).toBe("2026-03-04")
  })

  it("derives year_of_birth from age at operation, leaving month/day unknown", () => {
    const p = mapCasesToOmop([makeCase()]).person[0]
    expect(p.year_of_birth).toBe(2026 - 64)
    expect(p.month_of_birth).toBeNull()
    expect(p.day_of_birth).toBeNull()
  })

  it("maps sex to OMOP gender concepts, and unknown to 0", () => {
    expect(mapCasesToOmop([makeCase()]).person[0].gender_concept_id).toBe(8507)
    expect(mapCasesToOmop([makeCase({ preop: { ageYears: 40, sex: "FEMALE" } } as Partial<AnyCase>)])
      .person[0].gender_concept_id).toBe(8532)
    expect(mapCasesToOmop([makeCase({ preop: { ageYears: 40, sex: "OTHER" } } as Partial<AnyCase>)])
      .person[0].gender_concept_id).toBe(0)
  })

  it("leaves year_of_birth null rather than guessing when age is absent", () => {
    const p = mapCasesToOmop([makeCase({ preop: { sex: "MALE" } } as Partial<AnyCase>)]).person[0]
    expect(p.year_of_birth).toBeNull()
  })

  // The previous 32-bit string hash collided around ~70k cases, silently
  // merging two unrelated operations into one person.
  it("gives every case a distinct person_id across a large batch", () => {
    const cases = Array.from({ length: 5000 }, (_, i) => makeCase({ id: `case-${i}`, caseCode: `C-${i}` }))
    const ids = new Set(mapCasesToOmop(cases).person.map(p => p.person_id))
    expect(ids.size).toBe(5000)
  })

  it("keeps person_id an exact integer inside JS's safe range", () => {
    for (const p of mapCasesToOmop(Array.from({ length: 500 }, (_, i) => makeCase({ id: `c${i}` }))).person) {
      expect(Number.isSafeInteger(p.person_id)).toBe(true)
      expect(p.person_id).toBeGreaterThan(0)
    }
  })

  it("is deterministic — the same case exports the same pseudonym twice", () => {
    expect(mapCasesToOmop([makeCase()]).person[0].person_id)
      .toBe(mapCasesToOmop([makeCase()]).person[0].person_id)
  })

  it("never collides a person id with its own visit id", () => {
    const b = mapCasesToOmop([makeCase()])
    expect(b.person[0].person_id).not.toBe(b.visit_occurrence[0].visit_occurrence_id)
  })

  it("counts the new tables in the manifest", () => {
    const m = mapCasesToOmop([makeCase()]).metadata.table_counts
    expect(m.person).toBe(1)
    expect(m.observation_period).toBe(1)
  })

  it("no longer claims a strategy the code does not implement", () => {
    const s = mapCasesToOmop([makeCase()]).metadata.deidentification.person_id_strategy
    expect(s).toMatch(/SHA-256/)
    // and it must be honest about the one-person-per-case limitation
    expect(s).toMatch(/two persons|per case/i)
  })
})
