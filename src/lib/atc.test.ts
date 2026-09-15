import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { normalizeAtcCode } from "./atc"

describe("normalizeAtcCode", () => {
  it("keeps canonical codes at every ATC level", () => {
    for (const code of ["N", "N01", "N01A", "N01AX", "N01AX10"]) expect(normalizeAtcCode(code)).toBe(code)
    expect(normalizeAtcCode(" n01ax10 ")).toBe("N01AX10")
  })

  it("repairs the drug register's spelling of a substance code", () => {
    expect(normalizeAtcCode("L01BC 2")).toBe("L01BC02")
    expect(normalizeAtcCode("V09IX 4")).toBe("V09IX04")
    expect(normalizeAtcCode("L01XC 13")).toBe("L01XC13")
    expect(normalizeAtcCode("L01XC13")).toBe("L01XC13")
  })

  it("does not guess at anything else", () => {
    for (const value of ["", "   ", "L01BC 123", "01BC02", "L1BC02", "N02BE01, N02BE51", "ATC", null, undefined, 42]) {
      expect(normalizeAtcCode(value), String(value)).toBeNull()
    }
  })

  it("leaves no code in the shipped drug list that the concept map could not match", () => {
    const drugs = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src", "data", "drugs.json"), "utf8")) as { atc: string }[]
    const unrepaired = drugs.filter(drug => drug.atc && normalizeAtcCode(drug.atc) !== drug.atc)
    expect(unrepaired.slice(0, 5)).toEqual([])
  })
})
