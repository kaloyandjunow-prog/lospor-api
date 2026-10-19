import { describe, expect, it } from "vitest"
import { mapResearchDetail, type ResearchDetailRow } from "./mappers"

/** A finalised paediatric case with only the fields the scores depend on. */
function row(preop: Record<string, unknown>, postop: Record<string, unknown> = {}): ResearchDetailRow {
  return {
    researchId: "r1",
    status: "COMPLETE",
    clinicalMode: "PEDIATRIC",
    clinicalRulesVersion: null,
    finalizedAt: null,
    finalizations: [],
    fieldStatuses: [],
    selections: [],
    events: [],
    _count: { complications: 0 },
    intraop: null,
    preop: {
      diagnoses: [{ code: "J35.3", sourceCode: null, label: "Tonsils", labelEn: "Tonsils", labelBg: null, mappingStatus: "MAPPED" }],
      procedureRows: [],
      comorbidityRows: [],
      medications: [],
      labRows: [],
      assessmentAnswers: [],
      ...preop,
    },
    postop: { ...postop },
  } as unknown as ResearchDetailRow
}

describe("the scores in a research case", () => {
  it("carries POVOC and COLDS once for the case, not on each diagnosis", () => {
    const detail = mapResearchDetail(row({ povocScore: 2, povocRiskPercent: null, coldsApplicable: true, coldsScore: 17 }))
    expect(detail.demographics).toMatchObject({ povoc: 2, povocRiskPercent: 30, coldsApplicable: true, colds: 17 })
    expect(detail.diagnoses[0]).not.toHaveProperty("povoc")
    expect(detail.diagnoses[0]).not.toHaveProperty("colds")
  })

  it("carries the Aldrete subscores beside their total", () => {
    const detail = mapResearchDetail(row({}, {
      aldreteActivity: 2, aldreteRespiration: 2, aldreteCirculation: 1, aldreteConsciousness: 2, aldreteSpO2: 2, aldreteTotal: 9,
    }))
    expect(detail.postoperative).toMatchObject({
      aldreteActivity: 2, aldreteRespiration: 2, aldreteCirculation: 1, aldreteConsciousness: 2, aldreteSpO2: 2, aldreteTotal: 9,
    })
  })

  // A nullable answer nobody gave is unknown, not No. "?? false" exported an
  // unasked smoking question as a recorded non-smoker.
  it("keeps an unanswered yes/no question unknown", () => {
    const detail = mapResearchDetail(row({ smoking: null, difficultAirwayHistory: null }, { ponv: null }))
    expect(detail.demographics.smoking).toBeNull()
    expect(detail.demographics.difficultAirwayHistory).toBeNull()
    expect(detail.postoperative.ponv).toBeNull()
  })
})
