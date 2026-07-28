import { NextRequest, NextResponse, after } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { mapPreop, mapIntraop, mapPostop } from "./_mappers"
import { logAudit } from "@/lib/audit"
import { preopSchema, intraopSchema, postopSchema } from "@/lib/schemas/case"
import { parseLenient, type RejectedField } from "@/lib/lenient-parse"
import { checkClinicalPayloadPII, piiErrorBody } from "@/lib/clinical-pii"
import { syncCaseRelationalLockedSafe } from "@/lib/relational-sync"
import { caseWhereForUser } from "@/lib/access-control"
import { generateCaseCode, isPrismaUniqueError } from "@/lib/case-code"
import { corsHeaders } from "@/lib/cors"
import { z } from "zod"

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

async function findIdempotentCase(userId: string, idempotencyKey: string) {
  return prisma.case.findFirst({
    where: { userId, clientDraftId: idempotencyKey },
    select: { id: true, caseCode: true, preop: { select: { updatedAt: true, syncRevision: true } } },
  })
}


export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = user.id

  try {
    const body = await req.json()
    if (!body.preop) return NextResponse.json({ error: "preop required" }, { status: 400 })

    // Idempotency: mobile sends X-Idempotency-Key (= localDraftId) on case creation.
    // If we find an existing case with this key, return it without creating a duplicate.
    const idempotencyKey = req.headers.get("x-idempotency-key")
    if (idempotencyKey) {
      const existing = await findIdempotentCase(userId, idempotencyKey)
      if (existing) {
        return NextResponse.json({
          id: existing.id,
          caseCode: existing.caseCode,
          preopUpdatedAt: existing.preop?.updatedAt,
          preopRevision: existing.preop?.syncRevision,
        }, { status: 200 })
      }
    }

    // Lenient, exactly like PATCH. Creating a case is an autosave-style partial
    // write — the first draft save — and it used to be strict: one out-of-range
    // value (a height still being dragged past 12 cm) threw, the whole request
    // 400'd, and no case row was written at all. With no case id there was no
    // draft to return to, so leaving the screen destroyed the entire assessment.
    // Now the offending field is dropped and named, and everything else is kept.
    //
    // Finalising a case still uses a strict parse — that is where completeness
    // has to be enforced.
    const rejectedFields: RejectedField[] = []
    const takeRejected = (section: "preop" | "intraop" | "postop", rejected: RejectedField[]) => {
      // Prefix the section so one client mapper handles POST and PATCH alike.
      for (const r of rejected) rejectedFields.push({ ...r, path: `${section}.${r.path}` })
    }

    const preopParsed = parseLenient(preopSchema, body.preop)
    takeRejected("preop", preopParsed.rejected)
    const preop = preopParsed.value

    let intraop: z.infer<typeof intraopSchema> | undefined
    if (body.intraop) {
      const p = parseLenient(intraopSchema, body.intraop)
      takeRejected("intraop", p.rejected)
      intraop = p.value
    }

    let postop: z.infer<typeof postopSchema> | undefined
    if (body.postop) {
      const p = parseLenient(postopSchema, body.postop)
      takeRejected("postop", p.rejected)
      postop = p.value
    }

    if (rejectedFields.length) {
      // Paths only — the values are clinical data and must not reach the logs.
      console.warn(`[POST /api/cases] rejected fields:`, rejectedFields.map(f => f.path).join(", "))
    }

    const piiError = checkClinicalPayloadPII({ preop, intraop, postop, notes: body.notes })
    if (piiError) {
      after(() => logAudit(userId, "PII_BLOCKED", "new", { field: piiError.field, reason: piiError.reason }))
      return NextResponse.json(piiErrorBody(piiError), { status: 400 })
    }

    const status = postop ? "AWAITING_REVIEW" : intraop ? "IN_PROGRESS" : "DRAFT"

    let caseRecord
    for (let attempt = 0; ; attempt++) {
      try {
        caseRecord = await prisma.case.create({
          data: {
            userId,
            status,
            institutionId: user.institutionId ?? null,
            caseCode: await generateCaseCode(userId, prisma),
            ...(idempotencyKey ? { clientDraftId: idempotencyKey } : {}),
            preop: { create: { ...mapPreop(preop), syncRevision: 1 } },
            ...(intraop ? { intraop: { create: { ...mapIntraop(intraop), syncRevision: 1 } } } : {}),
            ...(postop  ? { postop:  { create: { ...mapPostop(postop), syncRevision: 1 } } } : {}),
          },
          include: {
            preop: { select: { updatedAt: true, syncRevision: true } },
          },
        })
        break
      } catch (e: unknown) {
        if (idempotencyKey && isPrismaUniqueError(e, "clientDraftId")) {
          const existing = await findIdempotentCase(userId, idempotencyKey)
          if (existing) {
            return NextResponse.json({
              id: existing.id,
              caseCode: existing.caseCode,
              preopUpdatedAt: existing.preop?.updatedAt,
              preopRevision: existing.preop?.syncRevision,
            }, { status: 200 })
          }
        }
        // Concurrent requests can compute the same next caseCode — retry with a
        // freshly-generated one rather than failing the whole create.
        if (isPrismaUniqueError(e, "caseCode") && attempt < 4) continue
        throw e
      }
    }

    after(() => logAudit(userId, "CASE_CREATE", caseRecord.id))
    after(() => syncCaseRelationalLockedSafe(caseRecord.id, userId))
    return NextResponse.json({
      id: caseRecord.id,
      caseCode: caseRecord.caseCode,
      preopUpdatedAt: caseRecord.preop?.updatedAt,
      preopRevision: caseRecord.preop?.syncRevision,
      ...(rejectedFields.length ? { rejectedFields } : {}),
    }, { status: 201 })
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    console.error(err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const where = caseWhereForUser(user)

  // Item 28: Pagination — accept optional ?skip and ?take; cap take at 200 per request
  const url = new URL(req.url)
  const skipRaw = Number(url.searchParams.get("skip") ?? "0")
  const skip = Number.isFinite(skipRaw) ? Math.max(0, skipRaw) : 0
  const takeRaw = Number(url.searchParams.get("take") ?? "50")
  // Number("abc") is NaN, and Math.min/max propagate it straight into Prisma,
  // which throws — a 500 from a malformed query string.
  const take = Number.isFinite(takeRaw) ? Math.min(200, Math.max(1, takeRaw)) : 50

  const [cases, total] = await Promise.all([
    prisma.case.findMany({
      where,
      include: {
        preop:  { select: { diagnosis: true, plannedProcedure: true, ageYears: true, sex: true, asaScore: true } },
        postop: { select: { disposition: true, aldreteTotal: true } },
        intraop: { select: { monthYear: true, durationMinutes: true, endTime: true } },
        user: { select: { name: true } },
        transfers: {
          where: { status: "PENDING" },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.case.count({ where }),
  ])

  return NextResponse.json({ cases, total, skip, take })
}
