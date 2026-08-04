import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  RESEARCH_DISTRIBUTION_IDS,
  RESEARCH_METRIC_IDS,
} from "@lospor/core/research"

type Schema = {
  enum?: string[]
  properties?: Record<string, Schema>
  items?: Schema
  required?: string[]
}

const document = JSON.parse(
  readFileSync(new URL("../generated/openapi.json", import.meta.url), "utf8"),
) as { components: { schemas: Record<string, Schema> } }

describe("pediatric OpenAPI contract", () => {
  it("stays aligned with the Core research vocabulary", () => {
    const schemas = document.components.schemas

    expect(schemas.ResearchMetric.properties?.id.enum).toEqual([...RESEARCH_METRIC_IDS])
    expect(schemas.ResearchDistribution.properties?.id.enum)
      .toEqual([...RESEARCH_DISTRIBUTION_IDS])
    expect(schemas.ResearchCohortFilters.properties).toHaveProperty("clinicalModes")
    expect(schemas.ResearchCohortFilters.properties).toHaveProperty("ageDays")
    expect(schemas.ResearchCaseSummary.required).toEqual(expect.arrayContaining([
      "clinicalMode",
      "clinicalRulesVersion",
      "ageValue",
      "ageUnit",
      "ageApproxDays",
    ]))
  })
})
