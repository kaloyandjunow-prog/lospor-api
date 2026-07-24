import { describe, expect, it } from "vitest"
import { parseIcd10BgRows } from "@/lib/icd10-bg-import"

describe("Bulgarian ICD-10 import", () => {
  it("reads the official Bulgarian workbook columns", () => {
    expect(parseIcd10BgRows([
      ["код", "наименование на кода"],
      ["k35", "ОСТЪР АПЕНДИЦИТ"],
      ["I10", "Есенциална (първична) хипертония"],
    ])).toEqual([
      { code: "K35", labelBg: "ОСТЪР АПЕНДИЦИТ" },
      { code: "I10", labelBg: "Есенциална (първична) хипертония" },
    ])
  })

  it("ignores invalid rows and deduplicates codes", () => {
    expect(parseIcd10BgRows([
      ["ICD code", "Description BG"],
      ["not-a-code", "Ignore"],
      ["K35.9", ""],
      ["K35.9", "Остър апендицит, неуточнен"],
      ["K35.9", "Остър апендицит"],
    ])).toEqual([
      { code: "K35.9", labelBg: "Остър апендицит" },
    ])
  })
})
