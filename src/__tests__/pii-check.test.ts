import { describe, it, expect } from "vitest"
import { checkPII } from "@/lib/pii-check"

describe("checkPII", () => {
  it("passes clean clinical notes", () => {
    expect(checkPII({ teamNotes: "Laparoscopic cholecystectomy, high risk" })).toBeNull()
    expect(checkPII({ teamNotes: null })).toBeNull()
    expect(checkPII({ teamNotes: undefined })).toBeNull()
    expect(checkPII({ teamNotes: "" })).toBeNull()
  })

  it("rejects two consecutive capitalised words (likely a name)", () => {
    expect(checkPII({ teamNotes: "Patient Ivan Petrov, allergy penicillin" })).not.toBeNull()
  })

  it("rejects email addresses", () => {
    expect(checkPII({ teamNotes: "contact dr.smith@hospital.bg for notes" })).not.toBeNull()
  })

  it("rejects 7+ digit numbers (medical record / ID)", () => {
    expect(checkPII({ teamNotes: "MRN 1234567 on chart" })).not.toBeNull()
  })

  it("rejects date patterns", () => {
    expect(checkPII({ teamNotes: "DOB 15.06.1980" })).not.toBeNull()
  })

  it("rejects valid EGN", () => {
    // 8001011234 — valid EGN structure (checksum verified)
    expect(checkPII({ teamNotes: "EGN 8001011234" })).not.toBeNull()
  })

  it("accepts numbers shorter than 7 digits", () => {
    expect(checkPII({ teamNotes: "SpO2 99%, HR 72, 3mg midazolam" })).toBeNull()
  })
})
