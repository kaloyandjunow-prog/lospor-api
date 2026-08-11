import { describe, expect, it, vi } from "vitest"

// `exports.ts` reaches Prisma, which is marked server-only; the serialisation
// under test does not touch either. Neutralising the marker keeps the test on
// the real writer instead of a reimplementation of it.
vi.mock("server-only", () => ({}))

import { mapCasesToOmop } from "@/lib/omop-mapper"
import { completeCaseFixture } from "@/__tests__/fixtures/complete-case"
import { pediatricCaseFixture } from "@/__tests__/fixtures/pediatric-case"
import {
  omopCsvColumns,
  omopCsvHeaderLine,
  omopCsvValueLine,
  type OmopTableName,
} from "./exports"

/**
 * The research OMOP export writes CSV from a hand-maintained column list, one
 * list per table. Nothing connected that list to the rows the mapper produces,
 * so a field could be added to a row and written to no file at all — no error,
 * no warning, a column simply absent from the download.
 *
 * That is not hypothetical. OBSERVATION gained `value_as_number` and about two
 * dozen clinical scores — Aldrete and its five subscores, RCRI, Apfel,
 * STOP-BANG, POVOC, COLDS, PAED, pain scores, age, BSA, duration, fluid totals,
 * volatile percentages — started being emitted as real numbers. The column list
 * still named eight columns, none of them `value_as_number`, so every one of
 * those numbers was dropped on the way to the file. The export looked healthy:
 * rows were the right count, the header parsed, the suite was green.
 *
 * These tests read the CSV text, not the declaration, and they cover every
 * table rather than the one that broke.
 */

function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ""
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (quoted) {
      if (character === "\"" && line[index + 1] === "\"") {
        cell += "\""
        index++
      } else if (character === "\"") {
        quoted = false
      } else {
        cell += character
      }
    } else if (character === "\"") {
      quoted = true
    } else if (character === ",") {
      cells.push(cell)
      cell = ""
    } else {
      cell += character
    }
  }
  cells.push(cell)
  return cells
}

function csvCellsFor(table: OmopTableName, row: Record<string, unknown>) {
  const header = parseCsvLine(omopCsvHeaderLine(table).trimEnd())
  const values = parseCsvLine(omopCsvValueLine(table, row).trimEnd())
  expect(values).toHaveLength(header.length)
  return new Map(header.map((column, index) => [column, values[index]]))
}

const bundle = mapCasesToOmop([completeCaseFixture() as never], {
  userId: "admin-1",
  userRole: "ADMIN",
  statusFilter: ["COMPLETE"],
  excludedCaseCount: 0,
  gitCommit: "test",
  forcedOverride: false,
})

const pediatricBundle = mapCasesToOmop([pediatricCaseFixture()])

const OMOP_TABLES: OmopTableName[] = [
  "person",
  "observation_period",
  "visit_occurrence",
  "condition_occurrence",
  "drug_exposure",
  "measurement",
  "procedure_occurrence",
  "observation",
]

describe("OMOP export CSV columns", () => {
  it.each(OMOP_TABLES)("writes every field the mapper emits for %s", table => {
    const rows = bundle[table] as unknown as Record<string, unknown>[]
    expect(rows.length).toBeGreaterThan(0)
    const emitted = [...new Set(rows.flatMap(row => Object.keys(row)))].sort()
    expect([...omopCsvColumns(table)].sort()).toEqual(emitted)
  })

  it("keeps the header and the value row in step", () => {
    for (const table of OMOP_TABLES) {
      const rows = bundle[table] as unknown as Record<string, unknown>[]
      const header = parseCsvLine(omopCsvHeaderLine(table).trimEnd())
      for (const row of rows) {
        expect(parseCsvLine(omopCsvValueLine(table, row).trimEnd())).toHaveLength(header.length)
      }
    }
  })

  it("carries the Aldrete total into value_as_number as a number", () => {
    const row = bundle.observation.find(
      item => item.observation_source_value === "LOSPOR:ALDRETE_TOTAL",
    )
    expect(row).toBeDefined()
    const cells = csvCellsFor("observation", row as unknown as Record<string, unknown>)
    // The fixture records a fully recovered patient: Aldrete 10 of 10.
    expect(cells.get("value_as_number")).toBe("10")
    expect(Number(cells.get("value_as_number"))).toBe(10)
    // The text form stays, so anything already reading value_as_string is unbroken.
    expect(cells.get("value_as_string")).toBe("10")
  })

  it("carries the other scored observations as numbers too", () => {
    const numeric = new Map<string, string>()
    for (const source of ["LOSPOR:POVOC_SCORE", "LOSPOR:COLDS_SCORE", "LOSPOR:PAED_SCORE"]) {
      const row = pediatricBundle.observation.find(
        item => item.observation_source_value === source,
      )
      expect(row, source).toBeDefined()
      numeric.set(
        source,
        csvCellsFor("observation", row as unknown as Record<string, unknown>)
          .get("value_as_number") ?? "",
      )
    }
    expect(Object.fromEntries(numeric)).toEqual({
      "LOSPOR:POVOC_SCORE": "2",
      "LOSPOR:COLDS_SCORE": "8",
      "LOSPOR:PAED_SCORE": "7",
    })
  })

  it("leaves a genuinely textual observation without a number", () => {
    const row = bundle.observation.find(
      item => item.observation_source_value === "LOSPOR:CLINICAL_MODE",
    )
    expect(row).toBeDefined()
    const cells = csvCellsFor("observation", row as unknown as Record<string, unknown>)
    expect(cells.get("value_as_number")).toBe("")
    expect(cells.get("value_as_string")).toBe("ADULT")
  })
})
