import { describe, expect, it } from "vitest"
import { isIcd10CodeLikeQuery, mergeIcd10Results } from "@/lib/icd10-search"

describe("ICD-10 search formatting", () => {
  it("uses Bulgarian display text when requested and keeps English metadata", () => {
    const results = mergeIcd10Results([
      [{ code: "I10", labelEn: "Essential hypertension", labelBg: "Есенциална хипертония" }],
    ], true)

    expect(results).toEqual([
      {
        code: "I10",
        description: "Essential hypertension",
        descriptionBg: "Есенциална хипертония",
        display: "I10 - Есенциална хипертония",
        system: "ICD-10",
      },
    ])
  })

  it("deduplicates by code while preserving priority order", () => {
    const results = mergeIcd10Results([
      [{ code: "E11", labelEn: "Type 2 diabetes mellitus", labelBg: "Захарен диабет тип 2" }],
      [{ code: "E11", labelEn: "Type 2 diabetes mellitus" }, { code: "E10", labelEn: "Type 1 diabetes mellitus" }],
    ], true)

    expect(results.map((row) => row.code)).toEqual(["E11", "E10"])
    expect(results[0].descriptionBg).toBe("Захарен диабет тип 2")
  })
  it("does not treat text terms as ICD-10 code searches", () => {
    expect(isIcd10CodeLikeQuery("append")).toBe(false)
    expect(isIcd10CodeLikeQuery("benign")).toBe(false)
    expect(isIcd10CodeLikeQuery("K35")).toBe(true)
    expect(isIcd10CodeLikeQuery("I10")).toBe(true)
  })
})
