import { describe, expect, it } from "vitest"
import { caseEventSchema } from "./case-event-schema"
import { CONTEXT_LINK_IDS } from "@lospor/core/intraop-suggestions"

const issue = (value: Record<string, unknown>) => {
  const result = caseEventSchema.safeParse(value)
  return result.success ? null : result.error.issues.map(item => item.message).join(" | ")
}
const ts = "2026-11-02T10:00:00Z"

describe("10.2.0 events", () => {
  it("accepts complications from the readings and from a suggestion, tagged with it", () => {
    expect(issue({ id: "c", ts, type: "complication", label: "Hypoxia / desaturation", complicationSource: "readings", suggestion: "reading:hypoxaemia" })).toBeNull()
    expect(issue({ id: "c", ts, type: "complication", label: "Hyperkalaemia", complicationSource: "suggestion", suggestion: "lab:hyperkalaemia", endTs: ts })).toBeNull()
    expect(issue({ id: "c", ts, type: "complication", label: "X", complicationSource: "magic" })).not.toBeNull()
  })

  it("accepts a drug given from a card, tagged with the card row", () => {
    expect(issue({ id: "d", ts, type: "drug", name: "Ephedrine", dose: "10", unit: "mg", suggestion: "card:Hypotension:ephedrine" })).toBeNull()
  })

  it("accepts the answers the suggestions write, and refuses an unknown one", () => {
    const answer = { id: "p", ts, type: "prompt_answer", answerFor: "c1" }
    expect(issue({ ...answer, answerKind: "card", answer: "done" })).toBeNull()
    expect(issue({ ...answer, answerKind: "card", answer: "not_now" })).toBeNull()
    expect(issue({ ...answer, answerKind: "reverse:lipid", answer: "not_now" })).toBeNull()
    expect(issue({ ...answer, answerKind: "reading:hypoxaemia", answer: "not_now" })).toBeNull()
    expect(issue({ ...answer, answerKind: "timer:tourniquetWarning", answer: "not_now" })).toBeNull()
    expect(issue({ ...answer, answerKind: "succession", answerFor: "succession:Positioned>Incision", suggestion: "succession:Positioned>Incision", answer: "dismissed" })).toBeNull()
    expect(issue({ ...answer, answerKind: CONTEXT_LINK_IDS.epiduralLocalAnaesthetic, answer: "done", value: "no" })).toBeNull()
    expect(issue({ ...answer, answerKind: CONTEXT_LINK_IDS.epiduralLocalAnaesthetic, answer: "dismissed" })).toBeNull()
    expect(issue({ ...answer, answerKind: "card", answer: "dismissed" })).toMatch(/succession or context prompt may be dismissed/)
    // A revealed card row records what it revealed, with no prompt answer.
    expect(issue({ ...answer, answerKind: "card-reveal:hypertonic-saline" })).toBeNull()
    expect(issue({ ...answer, answerKind: "reverse:lipid" })).toMatch(/names its reading/)
    expect(issue({ ...answer, answerKind: "something else", answer: "not_now" })).toMatch(/Unknown question/)
    expect(issue({ ...answer, answerKind: "card", answer: "maybe" })).not.toBeNull()
    // The 10.1.0 vitals answers still pass.
    expect(issue({ ...answer, answerKind: "hypotension", answer: "not_now" })).toBeNull()
  })

  it("keeps a tourniquet's site on the tourniquet", () => {
    expect(issue({ id: "t", ts, type: "clinical_event", label: "Tourniquet on", site: "rThigh" })).toBeNull()
    expect(issue({ id: "t", ts, type: "clinical_event", label: "Intubated", site: "rThigh" })).toMatch(/Only a tourniquet has a site/)
  })

  it("accepts jet ventilation within its ranges, starting with its pressure and rate", () => {
    expect(issue({ id: "j", ts, type: "jet_start", jetPressureBar: 2.5, jetRate: 150, fio2: 100 })).toBeNull()
    expect(issue({ id: "j", ts, type: "jet_change", jetRate: 300 })).toBeNull()
    expect(issue({ id: "j", ts, type: "jet_stop" })).toBeNull()
    expect(issue({ id: "j", ts, type: "jet_start", jetPressureBar: 2 })).toMatch(/starts with its pressure and rate/)
    expect(issue({ id: "j", ts, type: "jet_start", jetPressureBar: 7, jetRate: 150 })).not.toBeNull()
    expect(issue({ id: "j", ts, type: "jet_start", jetPressureBar: 2, jetRate: 601 })).not.toBeNull()
    expect(issue({ id: "d", ts, type: "drug", name: "Propofol", jetRate: 100 })).toMatch(/Only jet ventilation/)
  })
})
