import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { LAB_LIBRARY } from "@lospor/core/labs"

import { LAB_LOINC_MEANINGS } from "@/lib/lab-loinc-meanings"

/**
 * A LOINC code names an analyte *and* a scale, and both have to match what we
 * store.
 *
 * The check that existed before this one asked whether a code was standard,
 * valid and Measurement-domain. Fifteen wrong codes passed it: 415-0 is a
 * pivampicillin susceptibility and satisfied every structural rule while being
 * exported as a reticulocyte count. Nothing looked wrong in the app, because
 * the app shows our name and our number -- the error lived only in the exported
 * concept.
 *
 * So this asserts the two things structure cannot: that every seeded code has a
 * recorded meaning, and that the scale in that meaning matches the unit the
 * register actually stores. A future mass-for-molar slip fails here rather than
 * in somebody's analysis.
 */

const SEED = path.join(process.cwd(), "scripts", "seed-lab-loinc.ts")

function seededCodes(): Map<string, string> {
  const src = fs.readFileSync(SEED, "utf8")
  const codes = new Map<string, string>()
  for (const m of src.matchAll(/^\s+"([^"]+)":\s*"(\d+-\d)"/gm)) codes.set(m[1], m[2])
  return codes
}

/** The scale a LOINC concept name declares. */
function scaleOfConcept(name: string): string {
  const n = name.toLowerCase()
  if (/\[mass\/volume\]/.test(n)) return "mass"
  if (/\[moles\/volume\]/.test(n)) return "molar"
  if (/\[#\/volume\]/.test(n)) return "count"
  if (/\[enzymatic activity\/volume\]/.test(n)) return "activity"
  if (/\[units\/volume\]/.test(n)) return "units"
  if (/\/leukocytes|\/erythrocytes|\/hemoglobin\.total|volume fraction/.test(n)) return "ratio"
  return "other"
}

/** The scale our stored unit implies. */
function scaleOfUnit(unit: string): string {
  const u = unit.trim()
  if (u === "%") return "ratio"
  if (/mol\/L$/i.test(u)) return "molar"
  if (/^(g|mg|µg|μg|ng|pg)\/(L|dL|mL)$/i.test(u)) return "mass"
  if (/^U\/L$/i.test(u)) return "activity"
  if (/^(mIU|IU|mU)\/(L|mL)$/i.test(u)) return "units"
  if (/10\^/.test(u)) return "count"
  return "other"
}

describe("every exported lab code means what the test means", () => {
  const seeded = seededCodes()
  const unitOf = new Map(LAB_LIBRARY.map(test => [test.name, test.unit ?? ""]))

  it("finds the seed, so the checks below cannot pass on nothing", () => {
    expect(seeded.size).toBeGreaterThan(50)
  })

  it("records what every seeded code names", () => {
    const undocumented = [...seeded.keys()].filter(test => !LAB_LOINC_MEANINGS[test])

    expect(undocumented.sort(), "a code shipped without recording what it is").toEqual([])
  })

  it("keeps the recorded code and the seeded code the same", () => {
    // The manifest is a record of a verification. If the seed moves and the
    // record does not, the record is a claim about a code nobody checked.
    const drifted = [...seeded]
      .filter(([test, code]) => LAB_LOINC_MEANINGS[test] && LAB_LOINC_MEANINGS[test][0] !== code)
      .map(([test, code]) => `${test}: seed ${code}, verified ${LAB_LOINC_MEANINGS[test][0]}`)

    expect(drifted.sort(), "seed changed without re-verifying against the vocabulary").toEqual([])
  })

  /**
   * The one that would have caught all fifteen. A concept name states its
   * scale, and so does the unit we store; if they disagree, the exported
   * number is on a different scale from the code describing it -- a glucose in
   * mmol/L exported as the mg/dL concept reads as roughly one eighteenth of
   * itself to anyone who trusts the code.
   */
  it("exports each test under a code on the scale we store it in", () => {
    const mismatched: string[] = []
    for (const [test, [code, conceptName]] of Object.entries(LAB_LOINC_MEANINGS)) {
      const unit = unitOf.get(test)
      if (unit === undefined) continue
      const wanted = scaleOfUnit(unit)
      const got = scaleOfConcept(conceptName)
      if (wanted === "other" || got === "other") continue
      if (wanted !== got) {
        mismatched.push(`${test} (${unit}) -> ${code} is ${got}, we store ${wanted}: ${conceptName}`)
      }
    }

    expect(mismatched.sort(), "the code describes a different scale from the stored value").toEqual([])
  })

  it("names a test the register actually has", () => {
    const unknown = Object.keys(LAB_LOINC_MEANINGS).filter(test => !unitOf.has(test))

    expect(unknown.sort(), "a code recorded for a test that does not exist").toEqual([])
  })
})
