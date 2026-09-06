import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { LOINC_TO_LAB_TEST } from "@lospor/core/ehr-lab-codes"

/**
 * A lab result reaches a case by one of two routes -- typed by a clinician, or
 * imported from the hospital system -- and each route resolves its LOINC code
 * from a different table.
 *
 * The two tables answer different questions and are right to differ in shape:
 * the seed says which code a test is *exported* under, one per test; the import
 * map says which codes are *recognised* as that test, and a hospital may report
 * the same analyte several ways. What they must never do is disagree about the
 * code we ourselves emit, because then one measurement splits into two concepts
 * along a line that has nothing to do with the patient -- and a query for one
 * silently misses every result that arrived by the other route.
 *
 * That had happened twice before this test existed: arterial lactate exported
 * as unqualified blood lactate while the importer recognised the arterial code,
 * and creatinine exported in SI units under a code the importer did not know.
 */

const SEED = path.join(process.cwd(), "scripts", "seed-lab-loinc.ts")

/** testName -> the single LOINC code that test is exported under. */
function readSeedCodes(): Map<string, string> {
  const src = fs.readFileSync(SEED, "utf8")
  const codes = new Map<string, string>()
  for (const m of src.matchAll(/^\s+"([^"]+)":\s*"(\d+-\d)"/gm)) codes.set(m[1], m[2])
  return codes
}

/** testName -> every LOINC code the importer accepts as that test. */
function recognisedCodes(): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>()
  for (const [code, name] of Object.entries(LOINC_TO_LAB_TEST)) {
    if (!byName.has(name)) byName.set(name, new Set())
    byName.get(name)!.add(code)
  }
  return byName
}

describe("the code a lab exports under is one the importer knows", () => {
  const seed = readSeedCodes()
  const recognised = recognisedCodes()

  it("finds both tables, so the checks below cannot pass on nothing", () => {
    // The seed is parsed out of source. A rename or a reformat would otherwise
    // turn this whole file into a test that asserts an empty list equals an
    // empty list.
    expect(seed.size).toBeGreaterThan(50)
    expect(recognised.size).toBeGreaterThan(20)
  })

  it("never exports a test under a code the importer maps elsewhere", () => {
    const disagreeing: string[] = []
    for (const [name, exportedCode] of seed) {
      const accepted = recognised.get(name)
      // A test the importer does not know at all is a coverage gap, not a
      // contradiction, and is reported separately below.
      if (!accepted) continue
      if (!accepted.has(exportedCode)) {
        disagreeing.push(`${name}: exports ${exportedCode}, imported as ${[...accepted].join("/")}`)
      }
    }

    expect(disagreeing.sort(), "one test, two concepts, decided by how it was entered").toEqual([])
  })

  it("maps every importable code to a test that exists", () => {
    // The reverse direction: recognising a code as a test nothing can emit
    // would import results under a name with no reference range and no export
    // code of its own.
    const unknown = [...recognised.keys()].filter(name => !seed.has(name))

    expect(unknown.sort(), "importer recognises a test the register does not define").toEqual([])
  })
})
