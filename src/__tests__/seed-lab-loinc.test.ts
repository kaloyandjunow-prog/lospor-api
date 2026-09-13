import { describe, expect, it, vi } from "vitest"
import { INTENTIONALLY_UNCODED, seedLabLoinc } from "../../scripts/seed-lab-loinc"

describe("laboratory LOINC seed", () => {
  it("seeds 65 coded labs and preserves Anti-Xa as the one explicit uncoded exception", async () => {
    const upsert = vi.fn().mockResolvedValue({})
    const log = vi.fn()

    const result = await seedLabLoinc({ labLoinc: { upsert } } as never, { log })

    expect(result).toEqual({ coded: 65, intentionallyUncoded: 1 })
    expect(INTENTIONALLY_UNCODED).toEqual({
      "Anti-Xa": "The library does not distinguish unfractionated-heparin from low-molecular-weight-heparin assays.",
    })
    expect(upsert).toHaveBeenCalledTimes(65)
    expect(upsert.mock.calls.some(([request]) => request.where.name === "Anti-Xa")).toBe(false)
    expect(log).toHaveBeenCalledWith("Done. 65 coded, 1 intentionally uncoded.")
  })
})
