import { NextResponse } from "next/server"
import { logAuditInTransaction } from "@/lib/audit"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import {
  researchSelfAuthorizationExpiry,
  researchSelfAuthorizationStatus,
} from "@/lib/research/self-authorization"

async function clinicalUser(request: Request) {
  const user = await getAuthUser(request)
  if (!user?.id) {
    return { response: NextResponse.json({ error: "Authentication required", code: "UNAUTHORIZED" }, { status: 401 }) }
  }
  if (
    user.accountKind !== "CLINICAL"
    || !["MEMBER", "HEAD_OF_DEPT"].includes(user.role)
    || !user.institutionId
  ) {
    return {
      response: NextResponse.json(
        {
          error: "Self-authorization is available to institution clinicians",
          code: "RESEARCH_SELF_AUTHORIZATION_NOT_AVAILABLE",
        },
        { status: 403 },
      ),
    }
  }
  return { user }
}

export async function GET(request: Request) {
  const auth = await clinicalUser(request)
  if ("response" in auth) return auth.response
  const latest = await prisma.researchSelfAuthorization.findFirst({
    where: { userId: auth.user.id },
    orderBy: { createdAt: "desc" },
  })
  const now = new Date()
  const status = researchSelfAuthorizationStatus(latest?.createdAt ?? null, now)
  return NextResponse.json({
    eligible: status.eligible,
    nextEligibleAt: status.nextEligibleAt.toISOString(),
    activeUntil: latest && latest.expiresAt > now ? latest.expiresAt.toISOString() : null,
    permissions: {
      query: true,
      inspectCases: false,
      export: false,
      exportOmop: false,
      shareInstitutionCohorts: false,
    },
  })
}

export async function POST(request: Request) {
  const auth = await clinicalUser(request)
  if ("response" in auth) return auth.response
  const now = new Date()
  const outcome = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`research-self:${auth.user.id}`}))`
    const latest = await tx.researchSelfAuthorization.findFirst({
      where: { userId: auth.user.id },
      orderBy: { createdAt: "desc" },
    })
    const status = researchSelfAuthorizationStatus(latest?.createdAt ?? null, now)
    if (!status.eligible) return { created: null, nextEligibleAt: status.nextEligibleAt }
    const created = await tx.researchSelfAuthorization.create({
      data: {
        userId: auth.user.id,
        institutionId: auth.user.institutionId!,
        createdAt: now,
        expiresAt: researchSelfAuthorizationExpiry(now),
      },
    })
    await logAuditInTransaction(
      tx,
      auth.user.id,
      "RESEARCH_SELF_AUTHORIZE",
      created.id,
      {
        institutionId: created.institutionId,
        expiresAt: created.expiresAt.toISOString(),
        permissions: ["query"],
      },
    )
    return { created, nextEligibleAt: new Date(now.getTime() + 24 * 3_600_000) }
  })

  if (!outcome.created) {
    return NextResponse.json(
      {
        error: "Aggregate self-authorization is available once per 24 hours",
        code: "RESEARCH_SELF_AUTHORIZATION_COOLDOWN",
        nextEligibleAt: outcome.nextEligibleAt.toISOString(),
      },
      { status: 429 },
    )
  }
  return NextResponse.json({
    activeUntil: outcome.created.expiresAt.toISOString(),
    nextEligibleAt: outcome.nextEligibleAt.toISOString(),
    permissions: {
      query: true,
      inspectCases: false,
      export: false,
      exportOmop: false,
      shareInstitutionCohorts: false,
    },
  }, { status: 201 })
}
