import { describe, expect, it } from "vitest"
import { medicationRows } from "@lospor/core/vocabulary/medications"
import labDrugOmop from "@/data/lab-drug-omop.json"
import { combinationKey, innComponents } from "./medication-combination"

type Target = { concept: number } | { ingredients: number[] } | { unmapped: true }
const combinations = (labDrugOmop as unknown as { combinations: Record<string, Target> }).combinations

describe("a combination product's key", () => {
  it("is the ATC code with its ingredients, however the INN separates or orders them", () => {
    expect(combinationKey(" c09da03", "Valsartan, Hydrochlorothiazide")).toBe("C09DA03|hydrochlorothiazide+valsartan")
    expect(combinationKey("C09DA03", "hydrochlorothiazide/ Valsartan")).toBe("C09DA03|hydrochlorothiazide+valsartan")
    expect(combinationKey("J01CR02", "Amoxicillin + Clavulanic acid")).toBe("J01CR02|amoxicillin+clavulanic acid")
    expect(innComponents("Paracétamol,  Caffeine")).toEqual(["caffeine", "paracetamol"])
  })

  it("is none for a single substance, or without an ATC code", () => {
    expect(combinationKey("C09CA03", "Valsartan")).toBeNull()
    expect(combinationKey(null, "Valsartan, Hydrochlorothiazide")).toBeNull()
    expect(combinationKey("C09DA03", "Valsartan, valsartan")).toBeNull()
  })
})

// The bundled numbers (generate-lab-drug-omop.mts, Athena RxNorm 2026-06-01).
describe("the bundled combination mappings", () => {
  it("give valsartan with hydrochlorothiazide its own oral tablet concept, not valsartan", () => {
    expect(combinations["C09DA03|hydrochlorothiazide+valsartan"]).toEqual({ concept: 40045128 })
  })

  it("give amoxicillin with clavulanate both ingredients, since the list has it as tablets and powders", () => {
    expect(combinations["J01CR02|amoxicillin+clavulanic acid"]).toEqual({ ingredients: [1713332, 1759842] })
  })

  it("leave a combination RxNorm only partly names at concept 0", () => {
    // Terpin is not an RxNorm ingredient: not paracetamol, caffeine and the rest without it.
    expect(combinations["N02BE51|ascorbic acid+caffeine+paracetamol+phenylephrine+terpin"]).toEqual({ unmapped: true })
    // Valomindo: valsartan with indapamide, both rows, not valsartan alone.
    expect(combinations["C09DA03|indapamide+valsartan"]).toEqual({ ingredients: [978555, 1308842] })
  })

  it("key only products the medication list has, and never an ingredient set of one", () => {
    const listed = new Set(medicationRows().map(row => combinationKey(row.atc, row.inn)).filter(Boolean))
    for (const [key, target] of Object.entries(combinations)) {
      expect(listed.has(key), key).toBe(true)
      if ("ingredients" in target) expect(target.ingredients.length, key).toBeGreaterThan(1)
    }
  })
})
