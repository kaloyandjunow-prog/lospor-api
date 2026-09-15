import { describe, expect, it } from "vitest"

import { NHIS_CL024_LAB_CONCEPT_MAPS } from "../../scripts/nhis-cl024-lab-mappings"

describe("NHIS CL024 laboratory ConceptMap seed", () => {
  it("contains the complete reviewed set with no duplicate source keys", () => {
    expect(NHIS_CL024_LAB_CONCEPT_MAPS).toHaveLength(50)
    expect(new Set(NHIS_CL024_LAB_CONCEPT_MAPS.map(row => row.sourceCode)).size).toBe(50)
  })

  it("keeps exactly the four under-specified assays source-only", () => {
    expect(NHIS_CL024_LAB_CONCEPT_MAPS
      .filter(row => row.loincCode === null)
      .map(row => row.sourceCode)
      .sort())
      .toEqual(["00-00B-00", "00-00C-00", "00-00E-00", "00-02D-00"])
  })

  it("carries both official source labels for every reviewed key", () => {
    expect(NHIS_CL024_LAB_CONCEPT_MAPS.every(row => row.sourceLabelEn && row.sourceLabelBg)).toBe(true)
  })
})

