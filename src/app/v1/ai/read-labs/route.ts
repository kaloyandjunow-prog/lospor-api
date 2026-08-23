import { NextRequest, NextResponse } from "next/server"
import { convertLabValue, isConfidentConversion } from "@lospor/core/lab-unit-conversion"
import { LAB_LIBRARY } from "@/lib/labs"
import { getAuthUser } from "@/lib/mobile-auth"
import { fetchMistralChatCompletions } from "@/lib/mistral"
import { rateLimit } from "@/lib/rate-limit"
import { corsHeaders } from "@/lib/cors"
import { clinicalAiRefusal } from "@/lib/deployment-capabilities"

const MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
const MAX_BYTES = 10_485_760 // 10 MB
const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES * 4 / 3)
const MISTRAL_TIMEOUT_MS = Number(process.env.MISTRAL_TIMEOUT_MS ?? 45_000)

const LIBRARY_MAP = new Map(LAB_LIBRARY.map(test => [test.name, test.unit]))
const LIBRARY_TABLE = LAB_LIBRARY.map(test => `${test.name} | ${test.unit || "-"}`).join("\n")

const EXTRACT_PROMPT = `You are processing a laboratory report image.

CANONICAL LAB LIBRARY (exact name | canonical unit):
${LIBRARY_TABLE}

INSTRUCTIONS:
1. Extract every numerical laboratory test result visible in the image.
2. For each result, match it to the closest entry in the complete library above, considering all languages, abbreviations, and alternate spellings. Examples:
   - "Хемоглобин", "HGB", "Haemoglobin", "Hb" -> Haemoglobin (Hb)
   - "Лев.", "Leuk.", "WBC", "Leucocytes" -> Leucocytes (WBC)
   - "Тромбоцити", "Thrombozyten", "PLT" -> Platelets
   - "Креатинин", "CREA" -> Creatinine
   - "Глюкоза" -> Glucose
3. Use the EXACT name string from the library including all parentheses, subscripts, and special characters.
4. DISCARD any result that does not match a library entry. Do not guess and do not use the printed name.
5. DO NOT CONVERT ANYTHING. Report the number and the unit exactly as they are
   printed on the report. Unit conversion is performed afterwards by the server,
   which needs the original unit to do it correctly. If you convert, the value
   will be converted a second time and the stored result will be wrong.
   - If the report prints "1.0 mg/dL", return value "1.0" and unit "mg/dL".
   - If the report prints "88 μmol/L", return value "88" and unit "μmol/L".
   - Copy the unit even when it looks unusual. Never substitute the library unit.
6. Return ONLY a valid JSON array. Each element: { "test": string, "value": string, "unit": string }.
   - "test" must be an exact name from the library.
   - "value" is the number exactly as printed, as a string.
   - "unit" is the unit exactly as printed. If no unit is printed, return "".
7. No markdown, no explanation. If no matching results are found, return [].`

// Unit conversion lives in @lospor/core/lab-unit-conversion and is driven by the
// unit printed on the report. The heuristic that used to live here inferred the
// source unit from the magnitude of the number, which cannot work: canonical and
// conventional ranges overlap. A neonate's normal creatinine of 10 µmol/L was
// read as 10 mg/dL and stored as 884 µmol/L.

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const refusal = clinicalAiRefusal("labImageExtraction")
  if (refusal) return NextResponse.json(refusal.body, { status: refusal.status })

  const contentLength = Number(req.headers.get("content-length") ?? 0)
  if (contentLength > MAX_BYTES * 1.4) {
    return NextResponse.json({ error: "Image too large" }, { status: 413 })
  }

  const rl = await rateLimit(`ai-labs:${user.id}`, 10, 60 * 60 * 1000)
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many requests" }, {
      status: 429, headers: { "Retry-After": String(rl.retryAfter) },
    })
  }

  const apiKey = process.env.MISTRAL_API_KEY!

  let imageBase64: string
  let mimeType: string
  try {
    const body = await req.json()
    imageBase64 = body.imageBase64
    mimeType = body.mimeType
    if (typeof imageBase64 !== "string" || !imageBase64) throw new Error("missing imageBase64")
    if (!(MIME_TYPES as readonly string[]).includes(mimeType)) throw new Error("invalid mimeType")
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }
  if (imageBase64.length > MAX_BASE64_CHARS) {
    return NextResponse.json({ error: "Image too large" }, { status: 413 })
  }

  let mistralRes: Response
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MISTRAL_TIMEOUT_MS)
  try {
    mistralRes = await fetchMistralChatCompletions(apiKey, {
      model: process.env.MISTRAL_VISION_MODEL ?? "pixtral-12b-2409",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          { type: "text", text: EXTRACT_PROMPT },
        ],
      }],
      temperature: 0.1,
      max_tokens: 2000,
      stream: false,
    }, { signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[ai/read-labs] Mistral fetch timed out")
      return NextResponse.json({ error: "Lab scan timed out. Please crop the image tighter or try again." }, { status: 504 })
    }
    console.error("[ai/read-labs] Mistral fetch error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  } finally {
    clearTimeout(timeout)
  }

  if (!mistralRes.ok) {    console.error("[ai/read-labs] Mistral error:", mistralRes.status)  // body withheld: provider errors can echo the clinical payload
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }

  const json = await mistralRes.json()
  const content: string = json.choices?.[0]?.message?.content ?? ""

  let results: {
    test: string
    value: string
    unit: string
    /** As printed on the report, so the reviewer can check the conversion. */
    sourceValue: string
    sourceUnit: string
    conversionStatus: string
    /** False when the unit was unrecognised — such rows are not pre-selected. */
    confident: boolean
  }[] = []
  try {
    const clean = content.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim()
    const parsed = JSON.parse(clean)
    if (Array.isArray(parsed)) {
      results = (parsed as unknown[])
        .filter((row): row is { test: string; value: string; unit?: string } =>
          !!row &&
          typeof row === "object" &&
          typeof (row as Record<string, unknown>).test === "string" &&
          typeof (row as Record<string, unknown>).value === "string")
        .filter(row => LIBRARY_MAP.has(row.test))
        .map(row => {
          // Convert once, from the unit the report actually printed. The source
          // value and unit are kept so the review screen can show them beside
          // the converted result, and so nothing is ever silently rewritten.
          const conversion = convertLabValue(row.test, String(row.value), String(row.unit ?? ""))
          const converted = conversion.status === "converted" || conversion.status === "already-canonical"
          return {
            test: String(row.test),
            value: converted ? String(conversion.value) : String(row.value),
            // An unconverted value is still in whatever unit the report printed,
            // so it must not be labelled with the canonical one. Doing that put a
            // haematocrit of 0.41 on screen as "0.41 %" — a number and a unit that
            // do not belong together, in an editable field the clinician would
            // reasonably take as already reconciled.
            unit: converted ? conversion.unit : String(row.unit ?? ""),
            sourceValue: String(row.value),
            sourceUnit: String(row.unit ?? ""),
            conversionStatus: conversion.status,
            // Only rows converted with a known unit are safe to offer ticked.
            confident: isConfidentConversion(conversion),
          }
        })
    }
  } catch {
    console.warn("[ai/read-labs] Could not parse model output:", content.slice(0, 200))
  }

  return NextResponse.json({ results })
}
