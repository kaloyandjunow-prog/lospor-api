import { describe, expect, it } from "vitest"
import { bundledQuestion, DEFAULT_ENABLED_QUESTION_KEYS, FAMILY_HISTORY_FOLLOW_UP_KEYS } from "./catalog"

// The questions about malignant hyperthermia, myopathy and heat illness, and
// the family's history of them. Who is asked is a clinical decision, so it is
// pinned here rather than left to whoever edits the catalogue next.
//
// 10.0.0: one family-history question, the baseline one, on by default; its
// YES opens what it was (MH, suxamethonium apnoea, dystrophy, myasthenia).
// The separate "family history of MH, dystrophy or myasthenia" is gone.

const SYMPTOMS = ["S3_DARK_URINE", "S4_HEAT_STROKE"]
const FOLLOW_UPS = [...FAMILY_HISTORY_FOLLOW_UP_KEYS]

describe("susceptibility and family-history questions", () => {
  it("are asked of adults and children alike, except the child's death, which is paediatric only", () => {
    for (const key of [...SYMPTOMS, ...FOLLOW_UPS]) expect(bundledQuestion(key)?.applicability, key).toEqual([])
    expect(bundledQuestion("P10_FAMILY_CHILD_UNEXPLAINED_DEATH")?.applicability).toEqual(["PEDIATRIC"])
  })

  it("have both an English and a Bulgarian label", () => {
    for (const key of [...SYMPTOMS, ...FOLLOW_UPS, "BASE_FAMILY_ANAESTHESIA_PROBLEMS", "P10_FAMILY_CHILD_UNEXPLAINED_DEATH"]) {
      const question = bundledQuestion(key)
      expect(question?.labelEn.trim(), key).toBeTruthy()
      expect(question?.labelBg.trim(), key).toBeTruthy()
      expect(question?.labelBg, `${key} must not be left in English`).not.toBe(question?.labelEn)
    }
  })

  it("ask the family history once: the baseline question, on by default, with its follow-ups on too", () => {
    expect(bundledQuestion("S5_FAMILY_NEUROMUSCULAR")).toBeUndefined()
    expect(DEFAULT_ENABLED_QUESTION_KEYS.has("BASE_FAMILY_ANAESTHESIA_PROBLEMS")).toBe(true)
    for (const key of FOLLOW_UPS) {
      expect(bundledQuestion(key)?.parentKey, key).toBe("BASE_FAMILY_ANAESTHESIA_PROBLEMS")
      expect(DEFAULT_ENABLED_QUESTION_KEYS.has(key), key).toBe(true)
    }
  })

  it("name one condition per follow-up, each with its own family-history concept", () => {
    expect(FOLLOW_UPS.map(key => bundledQuestion(key)?.omopConceptId)).toEqual([4294884, 46273447, 4051573, 765130])
  })

  it("leave the symptoms off until an operator switches them on", () => {
    for (const key of [...SYMPTOMS, "P10_FAMILY_CHILD_UNEXPLAINED_DEATH"]) {
      expect(DEFAULT_ENABLED_QUESTION_KEYS.has(key), key).toBe(false)
    }
  })

  it("render in the anamnesis section, grouped under the MH heading", () => {
    for (const key of [...SYMPTOMS, ...FOLLOW_UPS]) {
      expect(bundledQuestion(key)?.formSection, key).toBe("anamnesis")
      expect(bundledQuestion(key)?.section, key).toBe("MH_SUSCEPTIBILITY")
    }
  })
})
