import { describe, expect, it } from "vitest"
import { labScanLocalProblems, labScanPrompt, labScanRows } from "./lab-scan-prompt"

/** A JPEG header carrying EXIF orientation 6, as a phone stores a portrait photo. */
function sidewaysJpegBase64(): string {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const length = app1.length + 2
  return Buffer.from([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...app1, 0xff, 0xda, 0, 2]).toString("base64")
}

describe("labScanPrompt (10.4.1)", () => {
  it("tells the model how to turn a photo the phone stored sideways", () => {
    expect(labScanPrompt(sidewaysJpegBase64(), "image/jpeg")).toMatch(/^NOTE: .*90 degrees clockwise/)
  })

  it("asks for each row whole, and says what sO2 and tCO2 are not", () => {
    const prompt = labScanPrompt(Buffer.from([0xff, 0xd8, 0xff, 0xda]).toString("base64"), "image/jpeg")
    expect(prompt).not.toMatch(/^NOTE/)
    expect(prompt).toMatch(/one ROW at a time/)
    expect(prompt).toMatch(/sO2 .* is not PaO2/)
    expect(prompt).toMatch(/"results"/)
  })

  it("adds no turn for a PNG", () => {
    expect(labScanPrompt("iVBORw0KGgo=", "image/png")).not.toMatch(/^NOTE/)
  })
})

describe("a hospital's own settings (Hospital 1.9.1)", () => {
  const local = {
    aliases: [{ printed: "ctHb", test: "Haemoglobin (Hb)" }, { printed: "Лев.", test: "Leucocytes (WBC)" }],
    instructions: "Our blood count prints no units.",
  }

  it("adds the names and the note after the rules, never in place of them", () => {
    const prompt = labScanPrompt("iVBORw0KGgo=", "image/png", local)
    expect(prompt).toMatch(/one ROW at a time/)
    expect(prompt).toMatch(/DO NOT CONVERT ANYTHING/)
    expect(prompt).toMatch(/"ctHb" -> Haemoglobin \(Hb\)/)
    expect(prompt).toMatch(/Our blood count prints no units\./)
    expect(prompt.indexOf("NOTES FROM THIS HOSPITAL")).toBeGreaterThan(prompt.indexOf("Rules:"))
    expect(prompt.trimEnd()).toMatch(/return \{ "results": \[\] \}\.$/)
  })

  it("leaves the released prompt as it was when nothing is set", () => {
    expect(labScanPrompt("iVBORw0KGgo=", "image/png")).not.toMatch(/THIS HOSPITAL/)
  })

  it("applies the names in code: the printed name decides, whatever the model chose", () => {
    const content = JSON.stringify({ results: [
      { printedName: "лев.", test: "Lymphocytes something", value: "34.57", unit: "" },
      { printedName: "CTHB ", test: "Haematocrit (Hct)", value: "75", unit: "g/L" },
      { printedName: "Glucose", test: "Glucose", value: "4.4", unit: "mmol/L" },
    ] })
    expect(labScanRows(content, local)).toEqual([
      { test: "Leucocytes (WBC)", value: "34.57", unit: "" },
      { test: "Haemoglobin (Hb)", value: "75", unit: "g/L" },
      { test: "Glucose", value: "4.4", unit: "mmol/L" },
    ])
  })

  it("refuses settings it cannot use", () => {
    expect(labScanLocalProblems(local)).toEqual([])
    expect(labScanLocalProblems({
      aliases: [
        { printed: "  ", test: "Glucose" },
        { printed: "Hb", test: "Not in the library" },
        { printed: "hb:", test: "Haemoglobin (Hb)" },
        { printed: "x".repeat(81), test: "Glucose" },
      ],
      instructions: "y".repeat(1501),
    }).map(problem => problem.kind)).toEqual(["printed-missing", "unknown-test", "duplicate-printed", "printed-too-long", "instructions-too-long"])
  })
})

describe("labScanRows", () => {
  it("reads the { results } object, keeping library rows only", () => {
    const content = JSON.stringify({ results: [
      { printedName: "Левкоцити (WBC)", section: "Кръвна картина", test: "Leucocytes (WBC)", value: "34.57", unit: "" },
      { printedName: "COHb", section: "", test: "Carboxyhaemoglobin made up", value: "1.5", unit: "%" },
    ] })
    expect(labScanRows(content)).toEqual([{ test: "Leucocytes (WBC)", value: "34.57", unit: "" }])
  })

  it("still reads the bare array, in a code fence, with a number for a value", () => {
    expect(labScanRows("```json\n[{\"test\":\"Glucose\",\"value\":4.4,\"unit\":\"mmol/L\"}]\n```"))
      .toEqual([{ test: "Glucose", value: "4.4", unit: "mmol/L" }])
  })

  it("reads anything else as no rows", () => {
    expect(labScanRows("{\"rows\": []}")).toEqual([])
    expect(() => labScanRows("Here is the table")).toThrow()
  })
})
