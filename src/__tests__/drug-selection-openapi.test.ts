import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

type OpenApiDocument = {
  components?: {
    schemas?: Record<string, {
      properties?: Record<string, unknown>
    }>
  }
}

describe("drug selection event OpenAPI contract", () => {
  it("publishes route-profile selections and immutable provenance", () => {
    const document = JSON.parse(readFileSync(
      join(process.cwd(), "src/generated/openapi.json"),
      "utf8",
    )) as OpenApiDocument
    const properties = document.components?.schemas?.Event?.properties ?? {}

    expect(Object.keys(properties)).toEqual(expect.arrayContaining([
      "drugRoute",
      "concentrationValue",
      "concentrationUnit",
      "formulation",
      "calculationBasis",
      "calculationWeightKg",
      "calculationMethod",
      "clinicalRuleKey",
      "clinicalRuleVersion",
      "clinicalRuleSourceIds",
      "clinicalPresetId",
      "clinicalPresetVersion",
      "clinicalPresetScope",
    ]))
  })
})
