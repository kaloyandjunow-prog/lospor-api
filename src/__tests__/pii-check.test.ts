import { describe, it, expect } from "vitest"
import { checkPII, redactText } from "@/lib/pii-check"

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

// redactText is what runs on the way OUT — into the AI prompt and into OMOP
// research exports — and it had no tests at all. That is why the name pattern
// below could destroy every Bulgarian diagnosis in both paths unnoticed: the
// only test touching this module covered checkPII, and the AI route's own
// suite mocks redactText to the identity function.
describe("redactText", () => {
  describe("the name heuristic must not fire on ordinary clinical text", () => {
    // The regression. The uppercase-first-letter slot used to include the whole
    // Cyrillic block (Ѐ-ӿ, lowercase а-я included), so any two adjacent
    // Bulgarian words matched whatever their case.
    it("leaves lowercase Bulgarian clinical text intact", () => {
      expect(redactText("остър апендицит")).toBe("остър апендицит")
      expect(redactText("Захарен диабет тип 2")).toBe("Захарен диабет тип 2")
      expect(redactText("хронична обструктивна белодробна болест"))
        .toBe("хронична обструктивна белодробна болест")
    })

    it("leaves lowercase Latin clinical text intact", () => {
      expect(redactText("acute appendicitis")).toBe("acute appendicitis")
    })
  })

  describe("it must still catch actual names", () => {
    it("redacts two capitalised words in either script", () => {
      expect(redactText("Иван Петров")).toBe("[REDACTED]")
      expect(redactText("John Smith")).toBe("[REDACTED]")
      expect(redactText("Patient Ivan Petrov, allergy penicillin"))
        .toContain("[REDACTED]")
    })
  })

  describe("coded clinical vocabulary opts out of the guess, not the checks", () => {
    const coded = { nameHeuristic: false }

    it("preserves catalogue labels that read as two capitalised words", () => {
      expect(redactText("Acute Cholecystitis", coded)).toBe("Acute Cholecystitis")
      expect(redactText("Laparoscopic Cholecystectomy", coded)).toBe("Laparoscopic Cholecystectomy")
      expect(redactText("Sodium Chloride", coded)).toBe("Sodium Chloride")
      expect(redactText("Previous Cormack-Lehane grade 3", coded))
        .toBe("Previous Cormack-Lehane grade 3")
    })

    it("still strips every structural identifier", () => {
      // These are the checks that actually find identifiers; opting out of the
      // name guess must never opt out of these.
      expect(redactText("EGN 8001011234", coded)).toContain("[REDACTED]")
      expect(redactText("MRN 1234567", coded)).toContain("[REDACTED]")
      expect(redactText("DOB 15.06.1980", coded)).toContain("[REDACTED]")
      expect(redactText("dr.smith@hospital.bg", coded)).toContain("[REDACTED]")
    })

    it("defaults to running the name heuristic when no option is passed", () => {
      expect(redactText("Acute Cholecystitis")).toBe("[REDACTED]")
    })
  })
})
