import { describe, expect, it } from "vitest"
import { checkClinicalPayloadPII, checkEventPII } from "@/lib/clinical-pii"

describe("clinical PII gate", () => {
  it("checks all major free-text clinical save fields", () => {
    const result = checkClinicalPayloadPII({
      preop: { physicalExamReport: "Contact test@example.com" },
      intraop: { bloodProductsNote: "No issue" },
      postop: {},
    })

    expect(result).toMatchObject({ field: "physicalExamReport", reason: "email" })
  })

  it("checks intraop/postop notes that were previously easy to miss", () => {
    expect(checkClinicalPayloadPII({ intraop: { bloodProductsNote: "File 1234567" } }))
      .toMatchObject({ field: "bloodProductsNote", reason: "long_number" })
    expect(checkClinicalPayloadPII({ postop: { dispositionNotes: "Seen on 01.02.2026" } }))
      .toMatchObject({ field: "dispositionNotes", reason: "date" })
  })

  it("does not treat controlled event labels as free-text PII", () => {
    const labels = [
      "Face Mask",
      "Oral ETT",
      "Double Lumen Tube",
      "Surgical Airway",
      "General Anaesthesia",
      "Regional Anaesthesia",
      "To PACU",
      "To ICU",
      "Vital Signs & Monitoring",
      "Angiotensin II",
      "Lloyd Davies",
    ]

    for (const label of labels) {
      expect(checkEventPII({ label })).toBeNull()
    }
  })

  it("checks free-text event notes before event append", () => {
    expect(checkEventPII({ label: "Complication", notes: "Ivan Petrov" }))
      .toMatchObject({ field: "notes", reason: "likely_name" })
  })

  it("allows drug names with two capitalised words in allergyDetails and currentMedications", () => {
    // Drug names like "Morphine Sulfate" or "Sodium Chloride" must not trigger the name check
    expect(checkClinicalPayloadPII({ preop: { allergyDetails: [{ label: "Morphine Sulfate", atcCode: "N02AA01" }] } })).toBeNull()
    expect(checkClinicalPayloadPII({ preop: { currentMedications: [{ label: "Sodium Chloride", inn: "sodium chloride" }] } })).toBeNull()
    expect(checkClinicalPayloadPII({ preop: { allergyDetails: [{ label: "Potassium Chloride", atcCode: "B05XA01" }] } })).toBeNull()
  })

  it("does not trust arbitrary array-shaped free text as a catalogue selection", () => {
    expect(checkClinicalPayloadPII({ preop: { currentMedications: [{ label: "Ivan Petrov" }] } }))
      .toMatchObject({ field: "currentMedications", reason: "likely_name" })
  })

  it("allows uppercase Bulgarian labels selected from coded clinical catalogues", () => {
    expect(checkClinicalPayloadPII({
      preop: {
        diagnoses: [{ code: "K35", label: "ОСТЪР АПЕНДИСИТ" }],
        diagnosis: "ОСТЪР АПЕНДИСИТ",
        comorbidities: [{ code: "I10", label: "АРТЕРИАЛНА ХИПЕРТОНИЯ" }],
        procedures: [{ code: "PROC-1", label: "ЛАПАРОСКОПСКА АПЕНДЕКТОМИЯ" }],
      },
    })).toBeNull()
  })

  it("still name-checks a legacy diagnosis without a coded selection", () => {
    expect(checkClinicalPayloadPII({ preop: { diagnosis: "Ivan Petrov" } }))
      .toMatchObject({
        field: "diagnosis",
        reason: "likely_name",
        blockedKeys: ["diagnosis", "icdCode"],
      })
  })

  it("still blocks EGN and long digit strings inside drug fields", () => {
    // Even in structured fields, clear PII like EGNs must be caught
    expect(checkClinicalPayloadPII({ preop: { allergyDetails: [{ label: "1234567890" }] } }))
      .toMatchObject({ field: "allergyDetails", reason: "long_number" })
  })
})
