import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { rateLimit } from "@/lib/rate-limit"
import { logAudit } from "@/lib/audit"
import { fetchMistralChatCompletions } from "@/lib/mistral"
import { redactText } from "@/lib/pii-check"
import { corsHeaders } from "@/lib/cors"
import { SYSTEM_PROMPT, buildPatientSummary } from "@/lib/ai-advisor"
import {
  AI_MAX_REQUESTS_PER_HOUR,
  AI_BURST_COOLDOWN_MS,
  AI_STREAM_TIMEOUT_MS,
} from "@/lib/constants"

const CORS = (req: NextRequest) => corsHeaders(req)

// Per-user burst throttle: last-request timestamp; entries older than 1 hour are pruned.
const lastRequestAt = new Map<string, number>()
const BURST_PRUNE_AGE_MS = 60 * 60 * 1000

function checkBurst(userId: string): boolean {
  const now = Date.now()
  for (const [uid, ts] of lastRequestAt.entries()) {
    if (now - ts > BURST_PRUNE_AGE_MS) lastRequestAt.delete(uid)
  }
  const last = lastRequestAt.get(userId)
  lastRequestAt.set(userId, now)
  return last === undefined || now - last >= AI_BURST_COOLDOWN_MS
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params

  // Load case with preop from DB — no client payload trusted for consent or clinical data
  const existing = await prisma.case.findUnique({
    where: { id },
    include: { preop: true },
  })

  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  if (existing.userId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // Consent check from DB — ignores any client-supplied aiOptIn
  if (!existing.preop?.aiOptIn) {
    return NextResponse.json({ error: "AI advice not enabled for this case" }, { status: 403 })
  }

  const rl = await rateLimit(`ai:${user.id}`, AI_MAX_REQUESTS_PER_HOUR, 60 * 60 * 1000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }

  if (!checkBurst(user.id)) {
    return NextResponse.json({ error: "Too many requests, wait a moment" }, { status: 429 })
  }

  const apiKey = process.env.MISTRAL_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: "AI advisor not configured" }, { status: 503 })
  }

  // Build prompt from server-loaded DB fields only
  const patientSummary = redactText(buildPatientSummary(existing.preop as Record<string, unknown>))

  // Log against case ID (not user.id twice)
  await logAudit(user.id, "AI_ADVISE", id, { optIn: true })

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
    console.error("[cases/ai/advise] Mistral fetch error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }

  if (!mistralRes.ok) {
    clearTimeout(timeoutHandle)
    const errText = await mistralRes.text().catch(() => "")
    console.error("[cases/ai/advise] Mistral error:", mistralRes.status, errText)
    if (mistralRes.status === 429) {
      return NextResponse.json(
        { error: "AI service is busy — please try again in a moment" },
        { status: 429 },
      )
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }

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
              if (text) controller.enqueue(encoder.encode(text))
            } catch (err) {
              console.error("[cases/ai/advise] Malformed stream chunk:", line, err)
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
