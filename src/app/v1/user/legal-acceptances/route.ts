import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { legalAcceptancesBodySchema } from "@/lib/legal-request"
import {
  LegalAcceptanceError,
  LegalConfigurationError,
  legalAcceptanceAuditDetail,
  legalAcceptanceCreateMany,
  mapLegalAcceptance,
} from "@/lib/legal-documents"
import { corsHeaders } from "@/lib/cors"
import { logAuditInTransaction } from "@/lib/audit"

const CORS = (request: NextRequest) => corsHeaders(request, "GET, POST, OPTIONS")

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(request) })
}

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS(request) })
  const records = await prisma.legalAcceptance.findMany({
    where: { userId: user.id },
    orderBy: { acceptedAt: "desc" },
  })
  return NextResponse.json({ acceptances: records.map(mapLegalAcceptance) }, { headers: CORS(request) })
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS(request) })
  const parsed = legalAcceptancesBodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Both exact TERMS and PRIVACY acceptances are required", code: "LEGAL_ACCEPTANCE_REQUIRED" },
      { status: 400, headers: CORS(request) },
    )
  }
  try {
    const rows = legalAcceptanceCreateMany(user.id, parsed.data.acceptances)
    await prisma.$transaction(async transaction => {
      const inserted = await transaction.legalAcceptance.createMany({ data: rows, skipDuplicates: true })
      const terms = rows.find(row => row.kind === "TERMS")
      const privacy = rows.find(row => row.kind === "PRIVACY")
      if (inserted.count > 0) {
        // Compatibility shadows for older clients. Exact LegalAcceptance rows
        // are authoritative; repeated submission of rows that already exist
        // must not rewrite these timestamps without a new acceptance event.
        await transaction.user.update({
          where: { id: user.id },
          data: {
            acceptedTermsAt: terms?.acceptedAt,
            acceptedPrivacyAt: privacy?.acceptedAt,
            termsVersion: terms?.documentVersion,
          },
        })
        await logAuditInTransaction(
          transaction,
          user.id,
          "LEGAL_ACCEPTANCE_RECORD",
          user.id,
          { ...legalAcceptanceAuditDetail(rows), acceptedDocumentCount: inserted.count },
        )
      }
    })
    return NextResponse.json({ ok: true, acceptances: parsed.data.acceptances }, { headers: CORS(request) })
  } catch (error) {
    if (error instanceof LegalAcceptanceError || error instanceof LegalConfigurationError) {
      return NextResponse.json(
        { error: error.message, code: error.code, ...(error instanceof LegalAcceptanceError ? { details: error.details } : {}) },
        { status: error.status, headers: CORS(request) },
      )
    }
    throw error
  }
}
