import { describe, expect, it } from "vitest"
import { csvCell, neutraliseFormula } from "../lib/csv-cell"

/**
 * Exports quoted delimiters but did nothing about a leading formula character.
 * The security reading of that (a crafted cell executing on open) is the exotic
 * case. The one that actually happens in a clinical register is a note beginning
 * with a dash, which a spreadsheet evaluates as arithmetic and renders as
 * #NAME? — so the exported value silently stops matching the record.
 */
describe("neutraliseFormula", () => {
  it("protects a dash-led clinical note — the case that actually occurs", () => {
    expect(neutraliseFormula("- no known allergies")).toBe("'- no known allergies")
    expect(neutraliseFormula("-ve pressure ventilation")).toBe("'-ve pressure ventilation")
  })

  it("protects the other characters a spreadsheet treats as a formula", () => {
    expect(neutraliseFormula("=1+1")).toBe("'=1+1")
    expect(neutraliseFormula("+44 tube")).toBe("'+44 tube")
    expect(neutraliseFormula("@handover")).toBe("'@handover")
    expect(neutraliseFormula("\tindented")).toBe("'\tindented")
  })

  it("leaves ordinary clinical text untouched", () => {
    for (const text of [
      "Laparoscopic cholecystectomy",
      "ASA III",
      "Propofol 2 mg/kg",
      "36.8",
      "Не са известни алергии",
      "",
    ]) {
      expect(neutraliseFormula(text)).toBe(text)
    }
  })

  it("only inspects the first character", () => {
    expect(neutraliseFormula("BP 120-80")).toBe("BP 120-80")
    expect(neutraliseFormula("SpO2 = 98%")).toBe("SpO2 = 98%")
  })
})

describe("csvCell", () => {
  it("still quotes delimiters, quotes and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"')
  })

  it("neutralises and quotes together when both apply", () => {
    // A dash-led note that also contains a comma needs both treatments.
    expect(csvCell("- no allergies, no reactions")).toBe(`"'- no allergies, no reactions"`)
  })

  it("renders null and undefined as empty", () => {
    expect(csvCell(null)).toBe("")
    expect(csvCell(undefined)).toBe("")
  })

  it("joins arrays before escaping", () => {
    expect(csvCell(["J35.0", "K80.2"])).toBe("J35.0 | K80.2")
  })

  it("protects an array whose first element starts a formula", () => {
    expect(csvCell(["-ve", "x"])).toBe("'-ve | x")
  })
})
