import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { canAccessCase } from "@/lib/access-control"
import { fetchMistralChatCompletions } from "@/lib/mistral"
import { prisma } from "@/lib/prisma"
import { rateLimit } from "@/lib/rate-limit"

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? ""

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const rl = await rateLimit(`vitals-scan:${user.id}`, 30, 60 * 60 * 1000)
  if (!rl.allowed) {
    return NextResponse.json({ error: "Rate limit reached. Try again later." }, {
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
    },
  })
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!canAccessCase(user, existing)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  let image: string
  let mimeType = "image/jpeg"
  try {
    const body = await req.json()
    image = body.image
    if (typeof body.mimeType === "string" && /^image\/(jpeg|png|webp|gif|heif|avif|bmp|tiff)$/.test(body.mimeType)) {
      mimeType = body.mimeType
    }
    if (!image || typeof image !== "string") throw new Error("missing image")
  } catch {
    return NextResponse.json({ error: "Expected { image: '<base64>' }" }, { status: 400 })
  }

  // Compressed 1600 px monitor photos are normally well below this limit.
  if (image.length > 5_600_000) {
    return NextResponse.json({ error: "Image too large. Please use a lower quality or crop the image." }, { status: 413 })
  }

  try {
    const res = await fetchMistralChatCompletions(MISTRAL_API_KEY, {
      model: process.env.MISTRAL_VISION_MODEL ?? "mistral-small-latest",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${image}` },
            },
            {
              type: "text",
              text: "Extract numeric vital sign readings from this patient monitor screen. Return ONLY valid JSON in exactly this format: {\"systolic\":null,\"diastolic\":null,\"heartRate\":null,\"spO2\":null,\"etco2\":null,\"temp\":null,\"rr\":null}. Replace null with the numeric value for each parameter you can clearly read. Return null for any parameter not visible or not legible. No explanation, no markdown, no extra text.",
            },
          ],
        },
      ],
      max_tokens: 120,
      temperature: 0,
    })

    if (!res.ok) {
      const err = await res.text()
      console.error("[vitals-scan] Mistral error:", res.status, err)
      return NextResponse.json({ error: "AI analysis failed" }, { status: 502 })
    }

    const json = await res.json()
    const raw = json.choices?.[0]?.message?.content?.trim() ?? ""

    // Extract JSON from response (Mistral sometimes wraps in markdown)
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) {
      return NextResponse.json({ error: "Could not parse monitor readings" }, { status: 422 })
    }

    const vitals = JSON.parse(match[0]) as {
      systolic: number | null
      diastolic: number | null
      heartRate: number | null
      spO2: number | null
      etco2: number | null
      temp: number | null
      rr: number | null
    }

    // Sanity-check ranges — reject obviously wrong readings
    if (vitals.systolic != null && (vitals.systolic < 40 || vitals.systolic > 300)) vitals.systolic = null
    if (vitals.diastolic != null && (vitals.diastolic < 20 || vitals.diastolic > 200)) vitals.diastolic = null
    if (vitals.heartRate != null && (vitals.heartRate < 20 || vitals.heartRate > 300)) vitals.heartRate = null
    if (vitals.spO2 != null && (vitals.spO2 < 50 || vitals.spO2 > 100)) vitals.spO2 = null
    if (vitals.etco2 != null && (vitals.etco2 < 5 || vitals.etco2 > 100)) vitals.etco2 = null
    if (vitals.temp != null && (vitals.temp < 30 || vitals.temp > 44)) vitals.temp = null
    if (vitals.rr != null && (vitals.rr < 4 || vitals.rr > 60)) vitals.rr = null

    return NextResponse.json(vitals)
  } catch (err) {
    console.error("[vitals-scan]", err)
    return NextResponse.json({ error: "AI analysis failed" }, { status: 500 })
  }
}
