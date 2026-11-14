import { NextRequest, NextResponse } from "next/server"
import { scanLabImage } from "@/lib/lab-scan"
import { logAudit } from "@/lib/audit"
import { getAuthUser } from "@/lib/mobile-auth"
import { canWriteCase } from "@/lib/access-control"
import { DEFAULT_VISION_MODEL } from "@/lib/mistral-models"
import { prisma } from "@/lib/prisma"
import { rateLimit } from "@/lib/rate-limit"
import { corsHeaders } from "@/lib/cors"
import { clinicalAiRefusal } from "@/lib/deployment-capabilities"

const MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
const MAX_BYTES = 10_485_760 // 10 MB
const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES * 4 / 3)
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? ""
const MISTRAL_TIMEOUT_MS = Number(process.env.MISTRAL_TIMEOUT_MS ?? 45_000)

// The scan itself -- prompt, answer, unit conversion -- lives in @/lib/lab-scan
// (10.4.1), shared with the appliance's Status test scan. Conversion is driven
// by the unit printed on the report: inferring it from the number's magnitude
// once stored a neonate's creatinine of 10 µmol/L as 884 µmol/L.

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

/**
 * Scanning a laboratory report is case-scoped, and deliberately so.
 *
 * This route sends a photograph to an external provider. A lab printout carries
 * the patient's name and EGN in its header; no text redaction is possible on an
 * image and none is attempted, which makes it the single most identifying
 * payload the system can transmit.
 *
 * The previous unscoped route took the caller's word for consent -- it read
 * `aiOptIn` from the request body -- so any authenticated caller could assert
 * consent that the clinical record did not contain. For a payload that cannot be
 * redacted, an attestation the server never checks is not a consent control.
 * Consent is now read from the case, exactly as the monitor scanner has always
 * done, and a client-supplied value is ignored entirely.
 *
 * The cost is that a lab report cannot be scanned into a case that does not
 * exist yet: the client saves first, then scans. That is the same order the
 * monitor scanner already requires, and the only honest one -- an unsaved draft
 * has no recorded consent to read.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const { id } = await params
  if (!id) return NextResponse.json({ error: "Bad request" }, { status: 400 })

  const existing = await prisma.case.findUnique({
    where: { id },
    select: {
      userId: true,
      user: { select: { institutionId: true } },
      preop: { select: { aiOptIn: true } },
    },
  })
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!canWriteCase(user, existing)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

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

  // Size first: an oversized payload is rejected on its own terms, before any
  // policy question, so the cheap structural guard cannot be masked by a
  // different refusal.
  if (imageBase64.length > MAX_BASE64_CHARS) {
    return NextResponse.json({ error: "Image too large" }, { status: 413 })
  }

  // Consent from the record, never from the request.
  if (!existing.preop?.aiOptIn) {
    return NextResponse.json({ error: "AI advice not enabled for this case" }, { status: 403 })
  }

  const outcome = await scanLabImage({
    apiKey: MISTRAL_API_KEY,
    model: process.env.MISTRAL_VISION_MODEL ?? DEFAULT_VISION_MODEL,
    imageBase64,
    mimeType,
    timeoutMs: MISTRAL_TIMEOUT_MS,
  })
  if (!outcome.ok) {
    if (outcome.kind === "timeout") {
      console.error("[cases/ai/read-labs] Mistral fetch timed out")
      return NextResponse.json({ error: "Lab scan timed out. Please crop the image tighter or try again." }, { status: 504 })
    }
    // body withheld: provider errors can echo the clinical payload
    console.error("[cases/ai/read-labs] Mistral", outcome.kind === "provider" ? `error: ${outcome.response.status}` : "fetch error")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
  if (outcome.unreadable) console.warn("[cases/ai/read-labs] Could not parse model output")
  const results = outcome.results

  // A successful send of a laboratory report photograph to an external provider
  // must leave a record. Previously only failures emitted anything, so the one
  // outcome that actually moved an identifying image off the appliance was the
  // one that left no trace. The image itself is never logged — only that the
  // transfer happened, against which case, by whom, and how many rows came back.
  await logAudit(user.id, "AI_LAB_SCAN", id, { optIn: true, rowCount: results.length })

  return NextResponse.json({ results })
}
