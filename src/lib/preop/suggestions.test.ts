import { describe, expect, it, vi } from "vitest"
import { buildPreopSuggestionCandidates, reviewPreopSuggestion } from "./suggestions"

describe("preoperative suggestion rules", () => {
  it("only suggests from current coded evidence", () => {
    const result = buildPreopSuggestionCandidates({
      clinicalMode: "ADULT",
      diagnoses: [{ id: "dx-1", label: "Unintentional weight loss", code: "R63.4", sourceCode: "R63.4" }],
      comorbidities: [],
      medications: [],
      labs: [],
    })
    expect(result).toContainEqual(expect.objectContaining({
      stableKey: "A3_UNINTENTIONAL_WEIGHT_LOSS",
      proposedState: "YES",
      linkedDiagnosisId: "dx-1",
      ruleId: "DX_WEIGHT_LOSS",
    }))
  })

  it("uses pediatric sleep-disordered-breathing connections", () => {
    const result = buildPreopSuggestionCandidates({
      clinicalMode: "PEDIATRIC",
      diagnoses: [{ label: "Obstructive sleep apnoea" }],
      comorbidities: [],
      medications: [],
      labs: [],
    })
    expect(result).toContainEqual(expect.objectContaining({
      stableKey: "P4_SLEEP_DISORDER_BREATHING",
      ruleId: "DX_SLEEP_DISORDER_BREATHING",
    }))
    expect(result).not.toContainEqual(expect.objectContaining({ stableKey: "BASE_STOPBANG_SNORING" }))
  })

  it("suggests bleeding only from supported current medications or labs", () => {
    const result = buildPreopSuggestionCandidates({
      clinicalMode: "ADULT",
      diagnoses: [],
      comorbidities: [],
      medications: [{ kind: "CURRENT", nameRaw: "Warfarin", inn: "warfarin", atcCode: "B01AA03" }],
      labs: [{ test: "Platelets", valueNum: 80, value: "80" }],
    })
    expect(result).toContainEqual(expect.objectContaining({ ruleId: "LAB_BLEEDING_SCREEN", stableKey: "A8_BLEEDING_DISORDER" }))
    expect(result).toContainEqual(expect.objectContaining({ ruleId: "MEDICATION_ANTITHROMBOTIC", stableKey: "A7_THROMBOSIS" }))
  })
})

describe("accepting a suggestion", () => {
  // Stored the way the forms hold the same answer (optionKey "YES"), so their
  // next autosave does not see a new answer and rewrite it as the clinician's.
  it("records the answer with the option code the forms use", async () => {
    const upserts: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = []
    const db = {
      preopAssessmentSuggestion: {
        findUnique: vi.fn(async () => ({
          id: "s-1", preopId: "preop-1", questionId: "q-1", profileVersion: 1,
          proposedState: "YES", proposedOptionKey: null, proposedValueText: null, proposedValueNumber: null,
          ruleId: "rule", ruleVersion: "1", linkedDiagnosisId: "dx-1",
          preop: { caseId: "case-1" },
          question: { options: [{ key: "YES" }, { key: "NO" }] },
        })),
        update: vi.fn(async ({ data }: { data: unknown }) => data),
      },
      preopAssessmentAnswer: {
        findFirst: vi.fn(async () => null),
        upsert: vi.fn(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => { upserts.push(args); return args.create }),
      },
      preopAssessmentProfile: { findFirst: vi.fn(async () => ({ id: "profile-1", questions: [] })) },
    }
    await reviewPreopSuggestion(db, { caseId: "case-1", suggestionId: "s-1", reviewerId: "clinician-1", status: "ACCEPTED" })

    expect(upserts[0].create).toMatchObject({ state: "YES", optionKey: "YES", source: "suggestion" })
    expect(upserts[0].update).toMatchObject({ optionKey: "YES" })
  })
})
