import { describe, expect, it } from "vitest"
import { automationDuplicateClinicalEvent, automationTechniqueConflict, coalesceAutomationClinicalEvent } from "./automation-conflicts"
import { rebaseAtomicIntraopPatch } from "./atomic-intraop-patch"
import type { LogEvent } from "@/types/timetable"

const T = "2026-11-05T10:00:00.000Z"

describe("automation conflict guards", () => {
  it("detects a contradictory inferred general technique", () => {
    expect(automationTechniqueConflict(
      { techniques: ["GENERAL_TIVA"] },
      { techniques: ["GENERAL_BALANCED"] },
    )).toEqual({ kind: "technique", current: "GENERAL_TIVA", incoming: "GENERAL_BALANCED" })
  })

  it("detects a contradictory inferred block side", () => {
    expect(automationTechniqueConflict(
      { techniques: ["BLOCK_FEMORAL"], techniqueSides: { BLOCK_FEMORAL: "LEFT" } },
      { techniques: ["BLOCK_FEMORAL"], techniqueSides: { BLOCK_FEMORAL: "RIGHT" } },
    )).toEqual({ kind: "side", current: "LEFT", incoming: "RIGHT" })
  })

  it("detects a contradiction between two context patches in the same batch", () => {
    const first = { techniques: ["GENERAL_TIVA"] }
    const virtual = rebaseAtomicIntraopPatch({}, first)
    expect(automationTechniqueConflict(virtual, { techniques: ["SEDATION_IV"] })).toEqual({
      kind: "technique", current: "GENERAL_TIVA", incoming: "SEDATION_IV",
    })
  })

  it("coalesces a retried context event by source relation, not timestamp alone", () => {
    const existing: LogEvent = {
      id: "first", ts: T, type: "clinical_event", label: "Epidural in",
      suggestion: "context:epidural-local-anaesthetic", clinicalRelation: "epidural-placement", sourceEventId: "drug-1",
    }
    const candidate: LogEvent = {
      id: "second", ts: T, type: "clinical_event", label: "Epidural in",
      suggestion: "context:epidural-event-technique", clinicalRelation: "epidural-placement", sourceEventId: "drug-1",
      intraopPatch: { techniques: ["EPIDURAL_SINGLE_SHOT"] },
    }
    const duplicate = automationDuplicateClinicalEvent([existing], candidate)
    expect(duplicate?.id).toBe("first")
    expect(coalesceAutomationClinicalEvent(duplicate!, candidate)).toMatchObject({
      id: "first", intraopPatch: { techniques: ["EPIDURAL_SINGLE_SHOT"] },
    })
  })
})

