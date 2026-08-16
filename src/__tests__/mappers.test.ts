import { describe, it, expect } from "vitest"
import { mapPreop, mapPreopUpdate, mapPostopUpdate } from "@/app/v1/cases/_mappers"

describe("mapPreop", () => {
  it("uses null (not 0) for missing biometrics", () => {
    const result = mapPreop({})
    expect(result.ageYears).toBeNull()
    expect(result.heightCm).toBeNull()
    expect(result.weightKg).toBeNull()
    expect(result.bmi).toBeNull()
  })

  it("leaves an unanswered clinical question unanswered", () => {
    // These used to default to false, so a case created from an empty payload
    // asserted "no" to every question before anyone had been asked one. A
    // clinician answering no and a question nobody asked were the same value.
    const result = mapPreop({})
    expect(result.smoking).toBeNull()
    expect(result.allergies).toBeNull()
    expect(result.difficultAirwayHistory).toBeNull()
  })

  it("still defaults the genuinely binary fields to false", () => {
    // Not every boolean is a question. High-risk surgery is binary by nature —
    // not high risk means not high risk — so it keeps a definite default.
    const result = mapPreop({})
    expect(result.highRiskSurgery).toBe(false)
    expect(result.emergencySurgery).toBe(false)
  })

  it("computes BMI from height and weight", () => {
    const result = mapPreop({ heightCm: 170, weightKg: 70 })
    expect(result.bmi).toBeCloseTo(70 / (1.7 ** 2), 1)
  })

  it("discards a client BMI that diverges more than 10% from computed", () => {
    const computed = 70 / (1.7 ** 2)  // ~24.2
    const result = mapPreop({ heightCm: 170, weightKg: 70, bmi: computed * 1.15 })
    expect(result.bmi).toBeCloseTo(computed, 1)
  })

  it("maps diagnoses array to legacy string column", () => {
    const result = mapPreop({ diagnoses: [{ label: "Hypertension" }, { label: "DM2" }] })
    expect(result.diagnosis).toBe("Hypertension; DM2")
  })

  it("maps mobile aliases: ulbt → upperLipBiteTest", () => {
    expect(mapPreop({ ulbt: "I" }).upperLipBiteTest).toBe("CLASS_I")
    expect(mapPreop({ ulbt: "II" }).upperLipBiteTest).toBe("CLASS_II")
    expect(mapPreop({ ulbt: "III" }).upperLipBiteTest).toBe("CLASS_III")
  })

  it("handles allergyDetails as string passthrough", () => {
    const result = mapPreop({ allergies: true, allergyDetails: "penicillin" })
    expect(result.allergyDetails).toBe("penicillin")
  })

  it("stores allergyDetails arrays as structured JSON", () => {
    const result = mapPreop({ allergies: true, allergyDetails: [{ label: "penicillin", inn: "penicillin", atcCode: "J01CE01" }] })
    expect(JSON.parse(result.allergyDetails ?? "[]")).toEqual([
      { label: "penicillin", inn: "penicillin", atcCode: "J01CE01" },
    ])
  })

  it("clears allergyDetails when allergies is false", () => {
    const result = mapPreop({ allergies: false, allergyDetails: [{ label: "penicillin" }] })
    expect(result.allergyDetails).toBeNull()
  })

  it("persists preop physical exam report and notes", () => {
    const result = mapPreop({
      physicalExamReport: "Clear lungs, no edema.",
      notes: "Discussed blood consent.",
    })
    expect(result.physicalExamReport).toBe("Clear lungs, no edema.")
    expect(result.notes).toBe("Discussed blood consent.")
  })
})

describe("mapPreopUpdate (partial — never wipes unspecified fields)", () => {
  it("only returns fields that are present in the payload", () => {
    const result = mapPreopUpdate({ ageYears: 45 })
    expect(result).toEqual({ ageYears: 45 })
    // Critically: no sex, no heightCm, no diagnosis keys at all
    expect("sex" in result).toBe(false)
    expect("heightCm" in result).toBe(false)
    expect("diagnosis" in result).toBe(false)
  })

  it("skips keys that are present but undefined (form snapshot of unfilled fields)", () => {
    // A snapshot taken when only age was filled — height/weight are undefined
    const result = mapPreopUpdate({ ageYears: 45, sex: "MALE", heightCm: undefined, weightKg: undefined })
    expect(result.ageYears).toBe(45)
    expect(result.sex).toBe("MALE")
    expect("heightCm" in result).toBe(false)
    expect("weightKg" in result).toBe(false)
  })

  it("includes derived diagnosis fields only when diagnoses is present", () => {
    const result = mapPreopUpdate({ diagnoses: [{ label: "Appendicitis" }] })
    expect(result.diagnosis).toBe("Appendicitis")
    expect("diagnosesJson" in result).toBe(true)
    expect("plannedProcedure" in result).toBe(false)
  })

  it("computes BMI when height and weight are both present", () => {
    const result = mapPreopUpdate({ heightCm: 170, weightKg: 70 })
    expect(result.bmi).toBeCloseTo(70 / (1.7 ** 2), 1)
  })

  it("returns an empty object for an empty payload (no fields wiped)", () => {
    expect(mapPreopUpdate({})).toEqual({})
  })

  it("includes preop physical exam report and notes when provided", () => {
    const result = mapPreopUpdate({
      physicalExamReport: "Airway exam repeated.",
      notes: "Needs senior review.",
    })
    expect(result).toEqual({
      physicalExamReport: "Airway exam repeated.",
      notes: "Needs senior review.",
    })
  })

  it("clears hidden allergy and family-anesthesia details when booleans are false", () => {
    const result = mapPreopUpdate({
      allergies: false,
      allergyDetails: [{ label: "penicillin" }],
      familyAnesthesiaProblems: false,
      familyAnesthesiaDetails: "malignant hyperthermia",
    })
    expect(result.allergyDetails).toBeNull()
    expect(result.familyAnesthesiaDetails).toBeNull()
  })
})

describe("mapPostopUpdate (partial)", () => {
  it("only returns present recovery vitals", () => {
    const result = mapPostopUpdate({ recoveryHeartRate: 72 })
    expect(result.recoveryHeartRate).toBe(72)
    expect("recoveryBpSystolic" in result).toBe(false)
    expect("disposition" in result).toBe(false)
  })

  it("recomputes aldreteTotal when a subscore is present", () => {
    const result = mapPostopUpdate({
      aldreteActivity: 2, aldreteRespiration: 2, aldreteCirculation: 2,
      aldreteConsciousness: 2, aldreteSpO2: 2,
    })
    expect(result.aldreteTotal).toBe(10)
  })

  // A partial score used to be summed with the unassessed components counted
  // as zero, so one component scored 2 was stored as an Aldrete of 2/10 — a
  // patient documented as apnoeic and unresponsive. There is no total until
  // all five have been assessed.
  it("leaves aldreteTotal unset while the score is incomplete", () => {
    const result = mapPostopUpdate({ aldreteActivity: 2 })
    expect(result.aldreteActivity).toBe(2)
    expect(result.aldreteTotal).toBeNull()
  })

  it("still refuses a total when four of five are scored", () => {
    const result = mapPostopUpdate({
      aldreteActivity: 2, aldreteRespiration: 2,
      aldreteCirculation: 2, aldreteConsciousness: 2,
    })
    expect(result.aldreteTotal).toBeNull()
  })

  it("returns an empty object for an empty payload", () => {
    expect(mapPostopUpdate({})).toEqual({})
  })
})
