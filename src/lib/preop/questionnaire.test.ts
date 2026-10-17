import { describe, expect, it } from "vitest"
import { defaultPreopProfileShape } from "./service"
import { preopQuestionnaire } from "./questionnaire"

const row = (stableKey: string, state: string, optionKey: string | null = null) => ({ state, optionKey, question: { stableKey } })

function withEnabled(keys: string[]) {
  const profile = defaultPreopProfileShape()
  return {
    ...profile,
    questions: profile.questions.map(question => keys.includes(question.stableKey)
      ? { ...question, enabled: true, byMode: Object.fromEntries(Object.entries(question.byMode ?? {}).map(([mode, settings]) => [mode, { ...settings, enabled: true }])) }
      : question),
  }
}

describe("the questionnaire on the preop summary", () => {
  it("lists every question shown on the form with its answer, no and unanswered included", () => {
    const items = preopQuestionnaire({ smoking: true, heartArrhythmia: false }, [], defaultPreopProfileShape(), "ADULT")
    const byKey = new Map(items.map(item => [item.stableKey, item]))
    expect(byKey.get("BASE_SMOKING")?.answer).toBe("YES")
    expect(byKey.get("BASE_HEART_ARRHYTHMIA")?.answer).toBe("NO")
    expect(byKey.get("BASE_RCRI_CHF")?.answer).toBeNull()
    expect(byKey.get("BASE_SMOKING")?.label.bg).toBeTruthy()
    // A children-only question is not on an adult's form.
    expect(byKey.has("BASE_POVOC_HISTORY")).toBe(false)
  })

  it("prints the operation's urgency and risk as their options", () => {
    const items = preopQuestionnaire({ emergencySurgery: true, highRiskSurgery: false }, [], defaultPreopProfileShape(), "ADULT")
    expect(items.find(item => item.stableKey === "BASE_SURGERY_URGENCY")?.option).toEqual({ en: "Emergency", bg: "Спешна" })
    expect(items.find(item => item.stableKey === "BASE_SURGERY_RISK")?.option).toEqual({ en: "Low risk", bg: "Нисък риск" })
  })

  it("lists a follow-up only under a yes", () => {
    const profile = withEnabled(["A11_DYSPHAGIA_ASPIRATION", "A11_LIQUIDS"])
    const yes = preopQuestionnaire({}, [row("A11_DYSPHAGIA_ASPIRATION", "YES"), row("A11_LIQUIDS", "NO")], profile, "ADULT")
    expect(yes.find(item => item.stableKey === "A11_LIQUIDS")).toMatchObject({ parentKey: "A11_DYSPHAGIA_ASPIRATION", answer: "NO" })
    const no = preopQuestionnaire({}, [row("A11_DYSPHAGIA_ASPIRATION", "NO")], profile, "ADULT")
    expect(no.find(item => item.stableKey === "A11_DYSPHAGIA_ASPIRATION")?.answer).toBe("NO")
    expect(no.some(item => item.stableKey === "A11_LIQUIDS")).toBe(false)
  })

  it("leaves out a question switched off, and the nil-by-mouth assignment printed on its own", () => {
    const items = preopQuestionnaire({}, [], defaultPreopProfileShape(), "PEDIATRIC")
    expect(items.some(item => item.stableKey === "A11_DYSPHAGIA_ASPIRATION")).toBe(false)
    expect(items.some(item => item.stableKey === "BASE_PEDIATRIC_FASTING")).toBe(false)
    // The score factors the forms show adults only.
    expect(items.some(item => item.stableKey === "BASE_RCRI_CHF" || item.stableKey === "BASE_STOPBANG_SNORING")).toBe(false)
    expect(items.some(item => item.stableKey === "BASE_POVOC_HISTORY")).toBe(true)
  })

  it("prints a choice question's chosen option", () => {
    const items = preopQuestionnaire({}, [row("A16_GUPTA_PROCEDURE_TYPE", "YES", "ANORECTAL")], withEnabled(["A16_GUPTA_PROCEDURE_TYPE"]), "ADULT")
    expect(items.find(item => item.stableKey === "A16_GUPTA_PROCEDURE_TYPE")?.option).toEqual({ en: "Anorectal", bg: "Аноректална" })
  })

  it("leaves the alcohol questions off a child under 14", () => {
    const profile = withEnabled(["S2_ALCOHOL_USE", "S2_ALCOHOL_HEAVY"])
    const answers = [row("S2_ALCOHOL_USE", "YES"), row("S2_ALCOHOL_HEAVY", "NO")]
    const keys = (preop: Record<string, unknown>, mode: string) => preopQuestionnaire(preop, answers, profile, mode).map(item => item.stableKey).filter(key => key.startsWith("S2_"))
    expect(keys({ ageValue: 9, ageUnit: "YEARS" }, "PEDIATRIC")).toEqual([])
    expect(keys({ ageValue: 15, ageUnit: "YEARS" }, "PEDIATRIC")).toEqual(["S2_ALCOHOL_USE", "S2_ALCOHOL_HEAVY"])
    expect(keys({ ageYears: 40 }, "ADULT")).toEqual(["S2_ALCOHOL_USE", "S2_ALCOHOL_HEAVY"])
  })
})
