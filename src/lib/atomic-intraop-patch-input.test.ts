import { afterEach, describe, expect, it, vi } from "vitest"
import { atomicIntraopPatchFrom } from "./atomic-intraop-patch-input"

afterEach(() => vi.unstubAllEnvs())

describe("the record change an event may carry", () => {
  it("keeps the airway, vascular and technique fields", () => {
    const result = atomicIntraopPatchFrom({
      airwayDevices: ["ORAL_ETT"], oralTubeSize: 7.5,
      vascularAccesses: [{ site: "VEN_PERIPHERAL", size: 18 }],
      techniques: ["BLOCK_FEMORAL"], techniqueSides: { BLOCK_FEMORAL: "LEFT" },
    })
    expect(result).toEqual({ ok: true, patch: expect.objectContaining({ airwayDevices: ["ORAL_ETT"], techniques: ["BLOCK_FEMORAL"] }) })
  })

  it("drops the end of the case and anything else outside its scope, so the audited end-correction route stays the only way", () => {
    const result = atomicIntraopPatchFrom({ techniques: ["GENERAL_TIVA"], endedAt: "2026-11-07T10:00:00.000Z", startTime: "08:00", notes: "x" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.keys(result.patch)).toEqual(["techniques"])
  })

  it("screens airway notes for identifying text, as the section save does", () => {
    vi.stubEnv("LOSPOR_DEPLOYMENT_MODE", "serverless")
    const result = atomicIntraopPatchFrom({ airwayNotes: "ЕГН 7501020018" })
    expect(result.ok).toBe(false)
  })

  it("refuses a malformed change", () => {
    expect(atomicIntraopPatchFrom({ oralTubeSize: "big" }).ok).toBe(false)
  })
})
