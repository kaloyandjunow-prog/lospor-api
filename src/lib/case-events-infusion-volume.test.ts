import { describe, expect, it, vi } from "vitest"
import { rebuildProjection } from "./case-events"

// Drug infusions count in the fluid balance by their recorded pump rates
// (2026-10-18): the server derives infusionsMl beside the fluid totals.

function fakeTx(events: Record<string, unknown>[]) {
  const upsert = vi.fn()
  const tx = {
    caseEvent: {
      findMany: vi.fn().mockResolvedValue(events.map((ev, index) => ({ logicalId: String(ev.id ?? index), version: 1, metadataJson: ev }))),
    },
    intraoperativeRecord: {
      findUnique: vi.fn().mockResolvedValue({
        startedAt: new Date("2026-10-18T10:00:00.000Z"),
        endedAt: new Date("2026-10-18T12:00:00.000Z"),
        startTime: null,
        createdAt: new Date("2026-10-18T09:00:00.000Z"),
        keyEvents: {},
        crystalloidsMl: null,
        colloidsMl: null,
        bloodMl: null,
        infusionsMl: null,
      }),
      upsert,
    },
  }
  return { tx, upsert }
}

describe("infused millilitres on the record", () => {
  it("are worked out from the pump rates of the events", async () => {
    const { tx, upsert } = fakeTx([
      { id: "s", ts: "2026-10-18T10:00:00.000Z", type: "infusion_start", infId: "i", name: "Norepinephrine / Noradrenaline", rate: "0.1", unit: "mcg/kg/min", concentration: "4 mg/50 mL", calculationWeightKg: 70, volumeRateMlPerHour: 5.25 },
      { id: "r", ts: "2026-10-18T11:00:00.000Z", type: "infusion_rate", infId: "i", rate: "0.2", unit: "mcg/kg/min", volumeRateMlPerHour: 10.5 },
      { id: "e", ts: "2026-10-18T11:30:00.000Z", type: "infusion_stop", infId: "i" },
    ])
    await rebuildProjection(tx as never, "c1", { revisionAlreadyReserved: true })
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ infusionsMl: 11 }),
    }))
  })

  it("stay empty when the syringe step was skipped", async () => {
    const { tx, upsert } = fakeTx([
      { id: "s", ts: "2026-10-18T10:00:00.000Z", type: "infusion_start", infId: "i", name: "Propofol", rate: "6", unit: "mg/kg/hr" },
      { id: "e", ts: "2026-10-18T11:00:00.000Z", type: "infusion_stop", infId: "i" },
    ])
    await rebuildProjection(tx as never, "c1", { revisionAlreadyReserved: true })
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ infusionsMl: null }),
    }))
  })
})
