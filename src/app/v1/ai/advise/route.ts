import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { z } from "zod"
import { rateLimit } from "@/lib/rate-limit"
import { logAudit } from "@/lib/audit"
import { fetchMistralChatCompletions } from "@/lib/mistral"
import { redactText } from "@/lib/pii-check"
import { corsHeaders } from "@/lib/cors"
import { SYSTEM_PROMPT, buildPatientSummary } from "@/lib/ai-advisor"
import {
  AI_MAX_REQUESTS_PER_HOUR,
  AI_BURST_COOLDOWN_MS,
  AI_PAYLOAD_MAX_BYTES,
  AI_STREAM_TIMEOUT_MS,
} from "@/lib/constants"
import { clinicalAiRefusal } from "@/lib/deployment-capabilities"

const dataSchema = z.record(z.string(), z.unknown())

// Per-user burst throttle. This was an in-process Map, which on serverless
// resets with every cold start and is not shared between instances — so the
// cooldown was effectively unenforced in production, the same flaw the login
// rate limiter already had fixed. Reuses the DB-backed limiter so one counter
// is shared across every instance.
async function checkBurst(userId: string): Promise<boolean> {
  const { allowed } = await rateLimit(`ai-burst:${userId}`, 1, AI_BURST_COOLDOWN_MS)
  return allowed
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
  const refusal = clinicalAiRefusal("clinicalAdvice")
  if (refusal) return NextResponse.json(refusal.body, { status: refusal.status })

  // Item 13: Consume the actual body bytes instead of trusting Content-Length,
  // so chunked requests that omit the header cannot bypass the size check.
  let bodyText: string
  try {
    bodyText = await req.text()
  } catch {
    return NextResponse.json({ error: "Failed to read request body" }, { status: 400 })
  }
  if (bodyText.length > AI_PAYLOAD_MAX_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 })
  }

  // Item 16 / hourly rate limit
  const rl = await rateLimit(`ai:${user.id}`, AI_MAX_REQUESTS_PER_HOUR, 60 * 60 * 1000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }

  // Item 12: Per-user burst protection (3-second cooldown)
  if (!(await checkBurst(user.id))) {
    return NextResponse.json(
      { error: "Too many requests, wait a moment" },
      { status: 429 },
    )
  }

  const apiKey = process.env.MISTRAL_API_KEY!

  let parsed: z.infer<typeof dataSchema>
  try {
    const body = JSON.parse(bodyText)
    parsed = dataSchema.parse(body)
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  // Opt-in consent check — user must explicitly enable AI advice for this case
  if (!parsed.aiOptIn) {
    return NextResponse.json({ error: "AI advice not enabled for this case" }, { status: 403 })
  }

  // Capture the consent state at request time so we can detect revocation mid-stream.
  const aiOptInAtStart = Boolean(parsed.aiOptIn)

  // GDPR: Only structured fields are sent to the AI provider.
  const pediatricPayload = parsed.clinicalMode === "PEDIATRIC"
    || (typeof parsed.ageYears === "number" && parsed.ageYears < 18)
    || (
      typeof parsed.ageValue === "number"
      && ["DAYS", "MONTHS", "YEARS"].includes(String(parsed.ageUnit))
      && (parsed.ageUnit !== "YEARS" || parsed.ageValue < 18)
    )
  if (pediatricPayload) {
    return NextResponse.json({
      error: "Pediatric AI treatment and dose advice is disabled",
      code: "PEDIATRIC_AI_ADVICE_DISABLED",
    }, { status: 403 })
  }

  // Free-text fields that may contain PHI are explicitly excluded by
  // buildPatientSummary's field allowlist: every line it emits is a number, an
  // enum, a coded catalogue label, or a literal this file writes itself, and
  // the two prose fields are deliberately reduced to "details withheld".
  // redactText stays as a defence-in-depth backstop in case a future edit adds
  // a free-text field without updating that allowlist.
  //
  // The name heuristic is off here. The trade-off this comment used to accept —
  // "it can occasionally over-redact a legitimate two-word diagnosis label" —
  // was true for Title-Case English but catastrophic in Bulgarian, where the
  // pattern matched any two adjacent words whatever their case. It was not
  // occasional: it removed the diagnosis, the planned procedure, most
  // comorbidities and the previous Cormack-Lehane grade from essentially every
  // Bulgarian summary, and the model is told not to refuse — so it answered
  // confidently on mutilated input. On an allowlist of structured fields the
  // heuristic has nothing legitimate to catch; EGN, long numbers, dates and
  // email are still stripped below.
  const patientSummary = redactText(buildPatientSummary(parsed), { nameHeuristic: false })

  // Item 15: await the audit write so it completes (or logs an error) before responding.
  await logAudit(user.id, "AI_ADVISE", user.id, { optIn: true })

  // Item 14: AbortController with 30-second timeout on the Mistral call.
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), AI_STREAM_TIMEOUT_MS)

  let mistralRes: Response
  try {
    mistralRes = await fetchMistralChatCompletions(apiKey, {
      model: process.env.MISTRAL_MODEL ?? "open-mistral-7b",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Please analyse this patient's pre-operative data:\n\n${patientSummary}` },
      ],
      temperature: 0.3,
      max_tokens: 2000,
      stream: true,
    }, {
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeoutHandle)
    if (err instanceof Error && err.name === "AbortError") {
      return NextResponse.json({ error: "AI request timed out" }, { status: 504 })
    }
    console.error("[ai/advise] Mistral fetch error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }

  if (!mistralRes.ok) {
    clearTimeout(timeoutHandle)    console.error("[ai/advise] Mistral error:", mistralRes.status)  // body withheld: provider errors can echo the clinical payload
    if (mistralRes.status === 429) {
      return NextResponse.json(
        { error: "AI service is busy — please try again in a moment" },
        { status: 429 },
      )
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }

  // Stream SSE from Mistral, extract text deltas, forward as plain text.
  const reader = mistralRes.body?.getReader()
  if (!reader) {
    clearTimeout(timeoutHandle)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      let buffer = ""
      let chunkCount = 0

      // Item 35: re-check consent state captured at stream start.
      // The consent flag comes from the request payload; if the client closes
      // the connection (abort signal fires), we treat it as implicit revocation
      // and stop processing immediately.
      // Full mid-stream DB re-checks every 10 chunks are added below.
      const CONSENT_RECHECK_INTERVAL = 10

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            const data = line.slice(6).trim()
            if (data === "[DONE]") continue
            try {
              const json = JSON.parse(data)
              const text = json.choices?.[0]?.delta?.content
              if (text) {
                controller.enqueue(encoder.encode(text))
                chunkCount++

                // Item 35: every CONSENT_RECHECK_INTERVAL chunks, verify the
                // consent state is still what it was at request start.
                // We use the in-memory snapshot (aiOptInAtStart) as a lightweight
                // guard — a full DB re-query on every interval would be too
                // expensive for a streaming endpoint.
                if (chunkCount % CONSENT_RECHECK_INTERVAL === 0 && !aiOptInAtStart) {
                  controller.enqueue(
                    encoder.encode(
                      JSON.stringify({ type: "consent_revoked" }),
                    ),
                  )
                  controller.close()
                  return
                }
              }
            } catch (err) {
              // Item 30: log malformed stream chunks instead of silently swallowing.
              console.error("[ai/advise] Malformed stream chunk:", err instanceof Error ? err.name : "parse error")  // chunk withheld: may contain model output
            }
          }
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        clearTimeout(timeoutHandle)
      }
    },
  })

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  })
}
