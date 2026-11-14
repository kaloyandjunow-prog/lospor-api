import { convertLabValue, isConfidentConversion } from "@lospor/core/lab-unit-conversion"
import { fetchMistralChatCompletions } from "@/lib/mistral"
import { EMPTY_LAB_SCAN_LOCAL, labScanPrompt, labScanRows, type LabScanLocal } from "@/lib/lab-scan-prompt"

/**
 * One lab-report scan: the image to the vision model, its answer back as
 * library rows converted from the printed unit (10.4.1).
 *
 * Shared by the case's scan and, on the appliance, by Status's test scan, so
 * the test shows exactly what a clinician would get.
 */

export type ScannedLabRow = {
  test: string
  value: string
  unit: string
  /** As printed on the report, so the reviewer can check the conversion. */
  sourceValue: string
  sourceUnit: string
  conversionStatus: string
  /** False when the unit was unrecognised — such rows are not pre-selected. */
  confident: boolean
}

export type LabScanOutcome =
  | { ok: true; results: ScannedLabRow[]; unreadable: boolean }
  | { ok: false; kind: "timeout" }
  | { ok: false; kind: "network"; error: unknown }
  /** The provider refused; the response is the caller's to read (a retired model, a 403). */
  | { ok: false; kind: "provider"; response: Response }

export async function scanLabImage(input: {
  apiKey: string
  model: string
  imageBase64: string
  mimeType: string
  local?: LabScanLocal
  timeoutMs: number
}): Promise<LabScanOutcome> {
  const local = input.local ?? EMPTY_LAB_SCAN_LOCAL
  let response: Response
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    response = await fetchMistralChatCompletions(input.apiKey, {
      model: input.model,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${input.mimeType};base64,${input.imageBase64}` } },
          { type: "text", text: labScanPrompt(input.imageBase64, input.mimeType, local) },
        ],
      }],
      temperature: 0.1,
      max_tokens: 3000,
      response_format: { type: "json_object" },
      stream: false,
    }, { signal: controller.signal })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { ok: false, kind: "timeout" }
    return { ok: false, kind: "network", error }
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) return { ok: false, kind: "provider", response }

  const json = await response.json()
  const content: string = json.choices?.[0]?.message?.content ?? ""
  try {
    return { ok: true, results: scannedRows(content, local), unreadable: false }
  } catch {
    // Model output can contain clinical content: the caller reports only that it was unreadable.
    return { ok: true, results: [], unreadable: true }
  }
}

/** The model's answer as rows, each converted once from the unit the report printed. */
export function scannedRows(content: string, local: LabScanLocal = EMPTY_LAB_SCAN_LOCAL): ScannedLabRow[] {
  return labScanRows(content, local).map(row => {
    // The source value and unit are kept so the review screen can show them
    // beside the converted result, and so nothing is ever silently rewritten.
    const conversion = convertLabValue(row.test, row.value, row.unit)
    const converted = conversion.status === "converted" || conversion.status === "already-canonical"
    return {
      test: row.test,
      value: converted ? String(conversion.value) : row.value,
      // An unconverted value is still in whatever unit the report printed, so
      // it must not be labelled with the canonical one: a haematocrit of 0.41
      // once showed as "0.41 %", a number and a unit that do not belong together.
      unit: converted ? conversion.unit : row.unit,
      sourceValue: row.value,
      sourceUnit: row.unit,
      conversionStatus: conversion.status,
      // Only rows converted with a known unit are safe to offer ticked.
      confident: isConfidentConversion(conversion),
    }
  })
}
