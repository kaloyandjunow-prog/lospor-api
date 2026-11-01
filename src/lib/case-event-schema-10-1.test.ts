import { describe, expect, it } from "vitest"

import { caseEventWriteSchema } from "./case-event-schema"

describe("10.1.0 events at the API boundary", () => {
  const ts = "2026-11-01T09:00:00.000Z"
  const issues = (event: Record<string, unknown>) => {
    const result = caseEventWriteSchema.safeParse(event)
    return result.success ? [] : result.error.issues.map(issue => issue.path.join("."))
  }

  it("accept a timed complication and an episode, refuse one that ends before it starts", () => {
    expect(issues({ id: "c", type: "complication", ts, label: "Laryngospasm", complicationSource: "timeline" })).toEqual([])
    expect(issues({ id: "c", type: "complication", ts, label: "Hypotension", complicationSource: "vitals", endTs: "2026-11-01T09:20:00.000Z", triggerReadingId: "r1" })).toEqual([])
    expect(issues({ id: "c", type: "complication", ts, label: "Hypotension", endTs: "2026-11-01T08:50:00.000Z" })).toEqual(["endTs"])
    expect(issues({ id: "c", type: "complication", ts })).toEqual(["label"])
    expect(issues({ id: "d", type: "drug", ts, name: "Propofol", dose: "100", unit: "mg", endTs: ts })).toEqual(["endTs"])
  })

  it("accept a shock of 1 to 360 J that says whether it was synchronised", () => {
    expect(issues({ id: "s", type: "defibrillation", ts, energyJ: 200, synchronized: false })).toEqual([])
    expect(issues({ id: "s", type: "defibrillation", ts, energyJ: 361, synchronized: false })).toEqual(["energyJ"])
    expect(issues({ id: "s", type: "defibrillation", ts, energyJ: 0.5, synchronized: true })).toEqual(["energyJ"])
    expect(issues({ id: "s", type: "defibrillation", ts, energyJ: 150 })).toEqual(["synchronized"])
    expect(issues({ id: "s", type: "defibrillation", ts, synchronized: true })).toEqual(["energyJ"])
  })

  it("accept a Not now only when it names its reading and its question", () => {
    expect(issues({ id: "p", type: "prompt_answer", ts, answerFor: "r1", answerKind: "tachycardia", answer: "not_now" })).toEqual([])
    expect(issues({ id: "p", type: "prompt_answer", ts, answerFor: "r1", answerKind: "fever", answer: "not_now" })).toEqual(["answerKind"])
    expect(issues({ id: "p", type: "prompt_answer", ts, answerKind: "tachycardia", answer: "not_now" })).toEqual(["answer"])
    expect(issues({ id: "p", type: "prompt_answer", ts, answerFor: "r1", answerKind: "tachycardia", answer: "later" })).toEqual(["answer"])
  })

  it("take the very ends of the energy range, in whole joules", () => {
    expect(issues({ id: "s", type: "defibrillation", ts, energyJ: 1, synchronized: false })).toEqual([])
    expect(issues({ id: "s", type: "defibrillation", ts, energyJ: 360, synchronized: true })).toEqual([])
    expect(issues({ id: "s", type: "defibrillation", ts, energyJ: 0, synchronized: false })).toEqual(["energyJ"])
    expect(issues({ id: "s", type: "defibrillation", ts, energyJ: "200", synchronized: false })).toEqual(["energyJ"])
  })

  it("refuse each new field on an entry it does not belong to", () => {
    expect(issues({ id: "v", type: "vital", ts, heartRate: 80, energyJ: 150 })).toEqual(["energyJ"])
    expect(issues({ id: "v", type: "vital", ts, heartRate: 80, synchronized: true })).toEqual(["energyJ"])
    expect(issues({ id: "v", type: "vital", ts, heartRate: 80, triggerReadingId: "r1" })).toEqual(["endTs"])
    expect(issues({ id: "v", type: "vital", ts, heartRate: 80, complicationSource: "vitals" })).toEqual(["endTs"])
    expect(issues({ id: "c", type: "complication", ts, label: "Hypotension", answer: "not_now" })).toEqual(["answer"])
    expect(issues({ id: "c", type: "complication", ts, label: "Hypotension", energyJ: 100 })).toEqual(["energyJ"])
    expect(issues({ id: "c", type: "complication", ts, label: "Hypotension", complicationSource: "ai" })).toEqual(["complicationSource"])
    expect(issues({ id: "c", type: "complication", ts, label: "   " })).toEqual(["label"])
    expect(issues({ id: "c", type: "complication", ts, label: "Hypotension", endTs: "yesterday" })).toEqual(["endTs"])
  })
})
