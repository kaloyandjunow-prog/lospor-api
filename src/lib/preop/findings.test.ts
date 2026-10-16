import { describe, expect, it } from "vitest"
import { preopSummaryFindings } from "./findings"

const yes = (stableKey: string, optionKey: string | null = null) => ({ state: "YES", optionKey, question: { stableKey } })

describe("the preop summary's findings", () => {
  it("lists every yes in catalogue order, baseline from its field, and never a no", () => {
    const findings = preopSummaryFindings(
      { smoking: true, heartArrhythmia: false, rcriCHF: null, allergies: true },
      [yes("A11_DYSPHAGIA_ASPIRATION"), yes("A11_LIQUIDS"), { state: "NO", question: { stableKey: "A6_POSTOP_DELIRIUM" } }],
    )
    expect(findings.map(finding => finding.stableKey)).toEqual(["BASE_SMOKING", "A11_DYSPHAGIA_ASPIRATION", "A11_LIQUIDS"])
    expect(findings[2]).toEqual({
      stableKey: "A11_LIQUIDS",
      parentKey: "A11_DYSPHAGIA_ASPIRATION",
      label: { en: "Difficulty swallowing liquids", bg: "Затруднения при преглъщане на течности" },
      option: null,
    })
  })

  it("leaves the allergy questions to their own frame and plans off the list", () => {
    expect(preopSummaryFindings({ allergies: true, latexAllergy: true, apfelPostopOpioids: true }, [])).toEqual([])
  })

  it("drops a follow-up whose question is not a finding", () => {
    expect(preopSummaryFindings({}, [yes("A11_LIQUIDS")])).toEqual([])
  })

  it("prints a choice question's chosen option", () => {
    const [finding] = preopSummaryFindings({}, [yes("A16_GUPTA_PROCEDURE_TYPE", "ANORECTAL")])
    expect(finding?.stableKey).toBe("A16_GUPTA_PROCEDURE_TYPE")
    expect(finding?.option).toEqual({ en: "Anorectal", bg: "Аноректална" })
  })
})
