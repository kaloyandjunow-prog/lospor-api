import { describe, expect, it } from "vitest"
import { mapIntraop, mapIntraopUpdate } from "@/app/v1/cases/_mappers"

describe("the side of a block when a case is saved (10.2.0)", () => {
  it("keeps the side of a technique that is on the list", () => {
    const mapped = mapIntraop({ techniques: ["GENERAL_TIVA", "BLOCK_FEMORAL"], techniqueSides: { BLOCK_FEMORAL: "LEFT" } })
    expect(mapped.techniqueSides).toEqual({ BLOCK_FEMORAL: "LEFT" })
  })

  it("drops a side whose technique was taken off the list, an unknown side, and a technique with no side", () => {
    const mapped = mapIntraop({ techniques: ["GENERAL_TIVA", "BLOCK_TAP"], techniqueSides: { BLOCK_FEMORAL: "LEFT", BLOCK_TAP: "UP", GENERAL_TIVA: "RIGHT" } })
    expect(mapped.techniqueSides).toEqual({})
  })

  it("saves an empty side map for an older case", () => {
    expect(mapIntraop({ techniques: ["BLOCK_FEMORAL"] }).techniqueSides).toEqual({})
  })

  it("writes the side on an update that sends it, and leaves it alone on one that does not", () => {
    const sent = mapIntraopUpdate({ techniques: ["BLOCK_SCIATIC"], techniqueSides: { BLOCK_SCIATIC: "RIGHT" } } as never)
    expect(sent.techniqueSides).toEqual({ BLOCK_SCIATIC: "RIGHT" })
    const other = mapIntraopUpdate({ positions: ["SUPINE"] } as never)
    expect("techniqueSides" in other).toBe(false)
  })
})
