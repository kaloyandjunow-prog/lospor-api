import { describe, expect, it } from "vitest"
import { intraopAttentionItems, intraopResolveAttention } from "@lospor/core/intraop-attention"
import { arrestEndRespace, arrestQuickDoseOps, cardSuggestionTag } from "@lospor/core/intraop-suggestions"
import { applyIntraopEventOps } from "@lospor/core/intraop-timetable-edit"
import type { LogEvent } from "@lospor/core/intraop-types"
import { scenario } from "@lospor/core/intraop-suggestions/scenarios"
import { caseEventWriteSchema } from "@/lib/case-event-schema"

/**
 * Core decides what to ask and what an answer writes; the API decides what it will accept. Nothing else holds the
 * two together, and a mismatch is silent: the answer is refused (400), the screen keeps the line, and the clinician
 * taps it again for ever. So every event any answer can write, in many random cases, goes through the real schema.
 */

const choiceOf = (item: ReturnType<typeof intraopAttentionItems>[number]): string | undefined => {
  const inner = item.suggestion?.item
  if (inner?.type === "reverse") return inner.question.choices[0]
  if (inner?.type === "reading" && inner.question.kind === "nearZero") return inner.question.choices[0]
  return undefined
}

describe("every event an answer writes is accepted by the API", () => {
  it("passes the event schema, for each line and each way of answering it", () => {
    const refused: string[] = []
    let written = 0
    for (let seed = 1; seed <= 300; seed++) {
      const { log, context } = scenario(seed)
      for (const item of intraopAttentionItems(log, context)) {
        for (const action of item.actions) {
          if (action === "open") continue
          const ops = intraopResolveAttention(log, item.key, action, context, choiceOf(item))
          for (const event of [...ops.add, ...ops.update]) {
            written += 1
            const result = caseEventWriteSchema.safeParse(event)
            if (!result.success) {
              refused.push(`seed ${seed} ${item.key} ${action} -> ${event.type}${event.answerKind ? ` ${event.answerKind}` : ""}: ${result.error.issues.map(issue => `${issue.path.join(".")} ${issue.message}`).join("; ")}`)
            }
          }
        }
      }
    }
    expect(written, "the cases wrote nothing, so this proved nothing").toBeGreaterThan(200)
    expect([...new Set(refused)].slice(0, 20)).toEqual([])
    // 300 random cases take about 5 s on a busy machine, the default limit.
  }, 30_000)

  it("accepts the doses tapped during an arrest, their approximate times, and the spread when it ends", () => {
    const arrest: LogEvent = { id: "arrest-1", ts: "2026-11-07T10:00:00.000Z", type: "complication", label: "Cardiac arrest" }
    const patient = { ageDays: 40 * 365, weightKg: 80 }
    const tag = cardSuggestionTag("Cardiac arrest", "adrenaline")
    let log: LogEvent[] = [arrest]
    const checked: LogEvent[] = []
    for (let tap = 0; tap < 4; tap++) {
      const ops = arrestQuickDoseOps(log, arrest, tap === 3 ? "Amiodarone" : "Epinephrine / Adrenaline", patient, "2026-11-07T10:50:00.000Z", tag)
      checked.push(...ops.add)
      log = applyIntraopEventOps(log, ops)
    }
    const rosc: LogEvent = { id: "rosc", ts: "2026-11-07T10:12:00.000Z", type: "clinical_event", label: "ROSC" }
    checked.push(rosc, ...arrestEndRespace(log, [...log, rosc]).update)
    expect(checked.length).toBeGreaterThan(4)
    for (const event of checked) {
      const result = caseEventWriteSchema.safeParse(event)
      expect(result.success, JSON.stringify(result.success ? "" : result.error.issues)).toBe(true)
    }
    expect(checked.some(event => event.timeApproximate === true)).toBe(true)
  })
})
