import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import type { Prisma } from "@/generated/prisma/client"
import { getAuthUser } from "@/lib/mobile-auth"
import { rateLimit } from "@/lib/rate-limit"
import { findPII } from "@/lib/pii-check"
import { corsHeaders } from "@/lib/cors"

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const q    = req.nextUrl.searchParams.get("q")?.trim().toLowerCase()
  const type = req.nextUrl.searchParams.get("type")?.trim()
  if (!q || q.length < 3) return NextResponse.json([])

  const institutionId = user.institutionId

  const where: Prisma.CustomTermWhereInput = {
    term: { contains: q, mode: "insensitive" },
    OR: [{ institutionId }, { institutionId: null }],
  }
  if (type) where.termType = type

  const terms = await prisma.customTerm.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: 20,
  })

  return NextResponse.json(terms.map(t => ({ code: t.code, term: t.term, termType: t.termType })))
}

// Format a numeric code as a zero-padded 7-digit string.
function formatCode(n: number): string {
  return String(n).padStart(7, "0")
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const rl = await rateLimit(`custom-terms:${user.id}`, 30, 60 * 60 * 1000)
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many requests" }, {
      status: 429, headers: { "Retry-After": String(rl.retryAfter) },
    })
  }

  const { term, termType } = await req.json()
  if (!term?.trim() || !termType) return NextResponse.json({ error: "Missing fields" }, { status: 400 })
  const piiError = findPII({ term: term.trim() })
  if (piiError) {
    return NextResponse.json({
      error: `${piiError.message} Please remove identifying information before saving.`,
      code: "PII_BLOCKED",
      field: piiError.field,
      reason: piiError.reason,
      retryable: false,
      blockedKeys: ["term"],
    }, { status: 400 })
  }

  const institutionId = user.institutionId

  // Check if this exact term already exists for this institution or as a global term (case-insensitive)
  const existing = await prisma.customTerm.findFirst({
    where: {
      term: { equals: term.trim(), mode: "insensitive" },
      termType,
      OR: [{ institutionId }, { institutionId: null }],
    },
  })
  if (existing) return NextResponse.json({ code: existing.code, term: existing.term })

  // Item 22: Wrap the max-code read and the insert in a transaction and retry
  // on unique-constraint violations so concurrent requests cannot silently
  // compute the same next code and then one of them fail with P2002.
  let attempts = 0
  while (attempts < 5) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const maxEntry = await tx.customTerm.findFirst({ orderBy: { code: "desc" } })
        const nextCode = formatCode(Number(maxEntry?.code ?? 0) + 1)
        return tx.customTerm.create({
          data: { code: nextCode, term: term.trim(), termType, institutionId },
        })
      })
      return NextResponse.json({ code: created.code, term: created.term }, { status: 201 })
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && e.code === "P2002") {
        // Unique constraint on code — another concurrent request got here first.
        attempts++
        continue
      }
      throw e
    }
  }

  return NextResponse.json(
    { error: "Could not generate a unique code after several attempts" },
    { status: 409 },
  )
}
