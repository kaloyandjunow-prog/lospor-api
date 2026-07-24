import { NextRequest, NextResponse } from "next/server"
import { LAB_LIBRARY } from "@/lib/labs"
import { getAuthUser } from "@/lib/mobile-auth"
import { fetchMistralChatCompletions } from "@/lib/mistral"
import { rateLimit } from "@/lib/rate-limit"
import { corsHeaders } from "@/lib/cors"

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
5. Convert the numeric value to the canonical unit shown in the library if the report uses a different unit:
   - Haemoglobin (Hb): g/dL x 10 -> g/L, e.g. 13.5 g/dL -> 135 g/L
   - Haematocrit (Hct): decimal ratio x 100 -> %, e.g. 0.42 -> 42
   - MCHC: g/dL x 10 -> g/L, e.g. 34 g/dL -> 340 g/L
   - Creatinine: mg/dL x 88.4 -> μmol/L
   - Glucose: mg/dL / 18.0 -> mmol/L
   - Urea (BUN): BUN mg/dL / 2.8 -> mmol/L
   - Total bilirubin / Direct bilirubin: mg/dL x 17.1 -> μmol/L
   - CRP: mg/dL x 10 -> mg/L
   - Calcium (Ca²⁺): mg/dL x 0.25 -> mmol/L
6. Return ONLY a valid JSON array. Each element: { "test": string, "value": string, "unit": string }.
   - "test" must be an exact name from the library.
   - "unit" must be the canonical unit from the library.
   - "value" is the converted numeric value as a string.
7. No markdown, no explanation. If no matching results are found, return [].`

function normaliseValue(name: string, raw: string): string {
  const n = parseFloat(raw.replace(",", "."))
  if (!isFinite(n)) return raw
  switch (name) {
    case "Haemoglobin (Hb)":
      if (n >= 5 && n <= 25) return String(Math.round(n * 10))
      break
    case "Haematocrit (Hct)":
      if (n > 0 && n < 1) return String(Math.round(n * 100 * 10) / 10)
      break
    case "Creatinine":
      if (n >= 0.3 && n <= 15) return String(Math.round(n * 88.4))
      break
    case "Glucose":
      if (n >= 50) return String(Math.round(n / 18.0 * 10) / 10)
      break
    case "Urea (BUN)":
      if (n >= 5 && n <= 200) return String(Math.round(n / 2.8 * 10) / 10)
      break
    case "Total bilirubin":
    case "Direct bilirubin":
      if (n >= 0.1 && n <= 30) return String(Math.round(n * 17.1 * 10) / 10)
      break
    case "CRP":
      if (n >= 0.01 && n <= 30) return String(Math.round(n * 10 * 10) / 10)
      break
    case "Calcium (Ca²⁺)":
      if (n >= 5 && n <= 15) return String(Math.round(n * 0.25 * 100) / 100)
      break
    case "MCHC":
      if (n >= 20 && n <= 40) return String(Math.round(n * 10))
      break
  }
  return raw
}

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

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

  const apiKey = process.env.MISTRAL_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: "AI not configured" }, { status: 503 })
  }

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

  if (!mistralRes.ok) {
    const errText = await mistralRes.text().catch(() => "")
    console.error("[ai/read-labs] Mistral error:", mistralRes.status, errText)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }

  const json = await mistralRes.json()
  const content: string = json.choices?.[0]?.message?.content ?? ""

  let results: { test: string; value: string; unit: string }[] = []
  try {
    const clean = content.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim()
    const parsed = JSON.parse(clean)
    if (Array.isArray(parsed)) {
      results = (parsed as unknown[])
        .filter((row): row is { test: string; value: string } =>
          !!row &&
          typeof row === "object" &&
          typeof (row as Record<string, unknown>).test === "string" &&
          typeof (row as Record<string, unknown>).value === "string")
        .filter(row => LIBRARY_MAP.has(row.test))
        .map(row => {
          const canonicalUnit = LIBRARY_MAP.get(row.test)!
          const normalisedValue = normaliseValue(row.test, String(row.value))
          return { test: String(row.test), value: normalisedValue, unit: canonicalUnit }
        })
    }
  } catch {
    console.warn("[ai/read-labs] Could not parse model output:", content.slice(0, 200))
  }

  return NextResponse.json({ results })
}
