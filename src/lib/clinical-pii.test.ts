import { afterEach, describe, expect, it, vi } from "vitest"
import { checkClinicalPayloadPII, checkEventPII, screensIdentifyingTextAtSave } from "./clinical-pii"

// Found on the appliance testing 1.5.1: clinical phrases read as names or dates
// and the save was refused ("Ритмична Сърдечна дейност", "ЕКГ от 12.10.2026").
const exam = (physicalExamReport: string) => ({ preop: { physicalExamReport } })

afterEach(() => { vi.unstubAllEnvs() })

describe("identifying text at save, on a hospital appliance (9.14.2)", () => {
  it("is stored as typed: it is cleaned on its way out instead", () => {
    vi.stubEnv("LOSPOR_DEPLOYMENT_MODE", "hospital")
    expect(screensIdentifyingTextAtSave()).toBe(false)
    expect(checkClinicalPayloadPII(exam("Ритмична Сърдечна дейност"))).toBeNull()
    expect(checkClinicalPayloadPII(exam("ЕКГ от 12.10.2026 норма"))).toBeNull()
    expect(checkClinicalPayloadPII({ preop: { currentMedications: [{ label: "Paracetamol Sopharma" }] } })).toBeNull()
    expect(checkEventPII({ note: "Иван Петров" })).toBeNull()
  })
})

describe("identifying text at save, on the cloud demo", () => {
  it("is still refused, so a name typed into a note never reaches the cloud", () => {
    vi.stubEnv("LOSPOR_DEPLOYMENT_MODE", "")
    expect(screensIdentifyingTextAtSave()).toBe(true)
    expect(checkClinicalPayloadPII(exam("Пациент Иван Петров"))).toMatchObject({ code: "PII_BLOCKED", field: "physicalExamReport" })
    expect(checkEventPII({ note: "ЕГН 7501020018" })).not.toBeNull()
  })

  it("is refused on any deployment that does not say it is a hospital", () => {
    vi.stubEnv("LOSPOR_DEPLOYMENT_MODE", "serverless")
    expect(screensIdentifyingTextAtSave()).toBe(true)
  })
})
