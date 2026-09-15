import { describe, expect, it } from "vitest"
import { DEFAULT_ADVISOR_MODEL, DEFAULT_VISION_MODEL } from "./mistral-models"

// These two identifiers broke every AI feature the moment a key was
// configured, because Mistral had already retired them (30 March 2025 and
// 31 December 2025). Never let either default land here again.
const RETIRED = ["open-mistral-7b", "pixtral-12b-2409"]

describe("the default Mistral models", () => {
  it("are dated identifiers, never a floating alias or a retired model", () => {
    for (const model of [DEFAULT_ADVISOR_MODEL, DEFAULT_VISION_MODEL]) {
      expect(RETIRED).not.toContain(model)
      expect(model).not.toMatch(/latest/)
      expect(model).toMatch(/^[a-z]+-[a-z]+-\d{4}$/)
    }
  })
})
