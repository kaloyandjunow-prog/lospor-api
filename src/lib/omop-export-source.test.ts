import { describe, expect, it } from "vitest"
import { redactEventFreeText, redactExportRow } from "./omop-export-source"

type Row = Parameters<typeof redactExportRow>[0]

// 9.14.2: identifying text is no longer refused at save on a hospital
// appliance, so the export is where it is cleaned -- in free text only.
const row = {
  id: "c1",
  preop: {
    diagnosis: "Acute Cholecystitis",
    plannedProcedure: "Laparoscopic Cholecystectomy",
    allergyDetails: "Benzylpenicillin Krka",
    currentMedications: "Co-Diovan Novartis",
    familyAnesthesiaDetails: "Майка Мария Иванова, реакция 12.03.1990",
    difficultAirwayNotes: "ЕГН 7501020018 в бележката",
    medications: [
      { nameRaw: "Sodium Chloride", inn: "sodium chloride", atcCode: "B05XA03" },
      // Typed as written (10.6.0): no ATC code, no INN.
      { nameRaw: "Билки от съседката Мария Иванова" },
    ],
    assessmentAnswers: [
      { state: "YES", optionKey: "CLEAR_FLUIDS", valueText: "Гладно от 06:00, звъннете на майката Елена Димитрова 0888123456" },
      { state: "YES", optionKey: "YES", valueText: null },
    ],
  },
  events: [{ label: "Propofol Fresenius", value: "Обадете се на Петър Георгиев" }],
  complications: [{ note: "имейл pacient@example.com" }],
  intraop: {
    complications: "Без Особености",
    premedicationEvening: "Midazolam",
    premedicationMorning: null,
    keyEvents: { log: [
      { id: "e1", type: "drug", name: "Sodium Chloride", unit: "mL", note: "дадено от Анна Петрова" },
      { id: "e2", type: "clinical_event", label: "Anaesthesia start" },
    ] },
    premedicationRows: [{ nameRaw: "Midazolam Roche" }],
  },
} as unknown as Row

describe("the OMOP export cleans free text only", () => {
  const out = redactExportRow(row) as unknown as typeof row & Record<string, never>
  const preop = (out as unknown as { preop: Record<string, unknown> }).preop
  const intraop = (out as unknown as { intraop: Record<string, unknown> }).intraop

  it("passes coded vocabulary through untouched", () => {
    expect(preop.diagnosis).toBe("Acute Cholecystitis")
    expect(preop.plannedProcedure).toBe("Laparoscopic Cholecystectomy")
    expect(preop.allergyDetails).toBe("Benzylpenicillin Krka")
    expect(preop.currentMedications).toBe("Co-Diovan Novartis")
    expect((preop.medications as { nameRaw: string }[])[0].nameRaw).toBe("Sodium Chloride")
    expect((out as unknown as { events: { label: string }[] }).events[0].label).toBe("Propofol Fresenius")
    expect((intraop.premedicationRows as { nameRaw: string }[])[0].nameRaw).toBe("Midazolam Roche")
  })

  it("cleans names, dates, ЕГН and email in free text", () => {
    expect(preop.familyAnesthesiaDetails).not.toMatch(/Мария Иванова|12\.03\.1990/)
    expect(preop.difficultAirwayNotes).not.toContain("7501020018")
    expect((out as unknown as { events: { value: string }[] }).events[0].value).not.toContain("Петър Георгиев")
    expect((out as unknown as { complications: { note: string }[] }).complications[0].note).not.toContain("@")
  })

  // A typed answer leaves as the observation value; it used to leave as typed.
  it("cleans the typed answer to a preoperative question, and only that", () => {
    const answers = preop.assessmentAnswers as { state: string; optionKey: string; valueText: string | null }[]
    expect(answers[0].valueText).not.toMatch(/Елена Димитрова|0888123456/)
    expect(answers[0]).toMatchObject({ state: "YES", optionKey: "CLEAR_FLUIDS" })
    expect(answers[1]).toEqual({ state: "YES", optionKey: "YES", valueText: null })
  })

  it("cleans only the typed parts of the event log", () => {
    const log = (intraop.keyEvents as { log: Record<string, unknown>[] }).log
    expect(log[0]).toMatchObject({ name: "Sodium Chloride", unit: "mL" })
    expect(log[0].note).not.toContain("Анна Петрова")
    expect(log[1]).toEqual({ id: "e2", type: "clinical_event", label: "Anaesthesia start" })
  })

  it("accepts a bare event array and leaves other shapes alone", () => {
    expect(redactEventFreeText([{ name: "Propofol Fresenius", comment: "Иван Петров" }]))
      .toEqual([{ name: "Propofol Fresenius", comment: "[REDACTED]" }])
    expect(redactEventFreeText(null)).toBeNull()
  })
})

describe("a current medication typed as written (10.6.0)", () => {
  const preop = (redactExportRow(row) as unknown as { preop: { medications: { nameRaw: string }[] } }).preop

  it("is cleaned like a note, while one picked from the list passes through", () => {
    expect(preop.medications[0].nameRaw).toBe("Sodium Chloride")
    expect(preop.medications[1].nameRaw).not.toContain("Мария Иванова")
  })
})
