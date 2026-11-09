import { describe, expect, it } from "vitest"
import { rebaseAtomicIntraopPatch } from "./atomic-intraop-patch"

describe("rebaseAtomicIntraopPatch", () => {
  it("keeps a device added by another client and applies the new device", () => {
    const result = rebaseAtomicIntraopPatch(
      { airwayDeviceEntries: [{ id: "old", device: "LMA", details: {}, status: "in_use" }], airwayDevices: ["LMA"] },
      { airwayDeviceEntries: [{ id: "new", device: "ORAL_ETT", details: { oralTubeSize: 7 }, status: "in_use" }], airwayDevices: ["ORAL_ETT"] },
    )
    expect(result.airwayDeviceEntries).toEqual([
      expect.objectContaining({ id: "old", device: "LMA", details: {}, status: "in_use" }),
      expect.objectContaining({ id: "new", device: "ORAL_ETT", details: { oralTubeSize: 7 }, status: "in_use" }),
    ])
    expect(result.airwayDevices).toEqual(["LMA", "ORAL_ETT"])
  })

  it("lets the incoming replacement update the same airway entry", () => {
    const result = rebaseAtomicIntraopPatch(
      { airwayDeviceEntries: [{ id: "tube", device: "ORAL_ETT", details: { oralTubeSize: 7 }, status: "in_use" }] },
      { airwayDeviceEntries: [{ id: "tube", device: "ORAL_ETT", details: { oralTubeSize: 8 }, status: "failed" }] },
    )
    expect(result.airwayDeviceEntries).toEqual([
      expect.objectContaining({ id: "tube", device: "ORAL_ETT", details: { oralTubeSize: 8 }, status: "failed" }),
    ])
  })

  it("does not let an older airway retry resurrect a newer failure", () => {
    const result = rebaseAtomicIntraopPatch(
      { airwayDeviceEntries: [{ id: "tube", device: "ORAL_ETT", details: { oralTubeSize: 8 }, insertedAt: "2026-11-05T10:00:00.000Z", status: "failed", endedAt: "2026-11-05T10:10:00.000Z" }] },
      { airwayDeviceEntries: [{ id: "tube", device: "ORAL_ETT", details: { oralTubeSize: 8 }, insertedAt: "2026-11-05T10:00:00.000Z", status: "in_use" }] },
    )
    expect(result.airwayDeviceEntries).toEqual([
      expect.objectContaining({ id: "tube", status: "failed", endedAt: "2026-11-05T10:10:00.000Z" }),
    ])
  })

  it("preserves current structured records when a stale patch carries empty arrays", () => {
    const result = rebaseAtomicIntraopPatch(
      {
        airwayDeviceEntries: [{ id: "tube", device: "ORAL_ETT", details: {}, status: "in_use" }],
        airwayDevices: ["ORAL_ETT"],
        vascularAccesses: [{ id: "line", site: "ART_RADIAL", insertedAt: "2026-11-05T10:00:00.000Z" }],
      },
      { airwayDeviceEntries: [], airwayDevices: [], airwayTools: [], vascularAccesses: [] },
    )
    expect(result.airwayDeviceEntries).toHaveLength(1)
    expect(result.airwayDevices).toEqual(["ORAL_ETT"])
    expect(result.vascularAccesses).toHaveLength(1)
  })

  it("unions vascular access by id and preserves an already-in-place line", () => {
    const result = rebaseAtomicIntraopPatch(
      { vascularAccesses: [{ id: "ward", site: "CVK_IJV", preexisting: true }] },
      { vascularAccesses: [{ id: "new", site: "ART_RADIAL" }] },
    )
    expect(result.vascularAccesses).toEqual([
      { id: "ward", site: "CVK_IJV", preexisting: true },
      { id: "new", site: "ART_RADIAL" },
    ])
  })

  it("does not rebase the explicit no-airway-intervention action", () => {
    expect(rebaseAtomicIntraopPatch(
      { airwayDeviceEntries: [{ id: "old", device: "LMA", details: {}, status: "in_use" }] },
      { airwayNotApplicable: true, airwayDeviceEntries: [], airwayDevices: [], airwayTools: [] },
    )).toEqual({ airwayNotApplicable: true, airwayDeviceEntries: [], airwayDevices: [], airwayTools: [] })
  })
})
