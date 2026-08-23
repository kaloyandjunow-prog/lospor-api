import { describe, expect, it } from "vitest"
import { mapResearchDetail, mapResearchSummary } from "./mappers"

const operationalCaseId = "cm0-operational-case-id"
const printedCaseCode = "2026-0042"
const opaqueResearchId = "12345678-1234-4234-8234-123456789abc"

function summaryRow() {
  return {
    id: operationalCaseId,
    caseCode: printedCaseCode,
    researchId: opaqueResearchId,
    status: "COMPLETE",
    clinicalMode: "ADULT",
    clinicalRulesVersion: null,
    finalizedAt: new Date("2026-08-01T10:00:00.000Z"),
    preop: null,
    intraop: null,
    postop: null,
    selections: [],
    fieldStatuses: [],
    _count: { complications: 0 },
  }
}

describe("research identifier boundary", () => {
  it("uses only the dedicated opaque identifier in summaries", () => {
    const mapped = mapResearchSummary(summaryRow() as never)
    expect(mapped.id).toBe(opaqueResearchId)
    expect(mapped.researchId).toBe(`RC-${opaqueResearchId}`)
    expect(JSON.stringify(mapped)).not.toContain(operationalCaseId)
    expect(JSON.stringify(mapped)).not.toContain(printedCaseCode)
  })

  it("replaces event database IDs with stable case-bound pseudonyms", () => {
    const row = {
      ...summaryRow(),
      finalizations: [{ finalizedAt: new Date("2026-08-01T10:00:00.000Z") }],
      complications: [],
      events: [{
        id: "cm0-operational-event-id",
        type: "note",
        timestamp: new Date("2026-08-01T09:00:00.000Z"),
        unit: null,
        clinicalEventCode: "NOTE",
      }],
    }
    const first = mapResearchDetail(row as never)
    const second = mapResearchDetail(row as never)
    expect(first.timeline[0].id).toMatch(/^EV-[a-f0-9]{32}$/)
    expect(first.timeline[0].id).toBe(second.timeline[0].id)
    expect(JSON.stringify(first)).not.toContain("cm0-operational-event-id")
    expect(JSON.stringify(first)).not.toContain(operationalCaseId)
    expect(JSON.stringify(first)).not.toContain(printedCaseCode)
  })
})
