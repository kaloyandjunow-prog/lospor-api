import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { preferredLocaleFromPreferences } from "@lospor/core/account"
import { accountLifecycleStatus, deletionDeadline } from "@/lib/account-lifecycle"
import { activeLegalDocuments, mapLegalAcceptance } from "@/lib/legal-documents"
import type { Prisma } from "@/generated/prisma/client"

const statusSchema = z.enum([
  "INVITED",
  "ACTIVE",
  "SUSPENDED",
  "DELETION_PENDING",
  "RECOVERY_REQUIRED",
])

function lifecycleWhere(status: z.infer<typeof statusSchema>): Prisma.UserWhereInput {
  const recoverable = { anonymizedAt: null }
  switch (status) {
    case "INVITED":
      return {
        ...recoverable,
        activatedAt: null,
        suspendedAt: null,
        recoveryRequiredAt: null,
        deletedAt: null,
      }
    case "ACTIVE":
      return {
        ...recoverable,
        activatedAt: { not: null },
        suspendedAt: null,
        recoveryRequiredAt: null,
        deletedAt: null,
      }
    case "SUSPENDED":
      return { ...recoverable, suspendedAt: { not: null }, deletedAt: null }
    case "DELETION_PENDING":
      return { ...recoverable, deletedAt: { not: null } }
    case "RECOVERY_REQUIRED":
      return { ...recoverable, recoveryRequiredAt: { not: null }, deletedAt: null }
  }
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!requireRole(user, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const url = new URL(req.url)
  const requestedStatus = url.searchParams.get("status")
    ?? (url.searchParams.get("pending") === "true" ? "INVITED" : null)
  const parsedStatus = requestedStatus ? statusSchema.safeParse(requestedStatus) : null
  if (parsedStatus && !parsedStatus.success) {
    return NextResponse.json({ error: "Invalid lifecycle status" }, { status: 400 })
  }

  const query = url.searchParams.get("q")?.trim().normalize("NFKC") ?? ""
  if (query.length > 100) {
    return NextResponse.json({ error: "Search query is too long" }, { status: 400 })
  }
  const lifecycle = parsedStatus?.success ? lifecycleWhere(parsedStatus.data) : { anonymizedAt: null }
  const users = await prisma.user.findMany({
    where: query
      ? {
          AND: [
            lifecycle,
            {
              OR: [
                { username: { contains: query, mode: "insensitive" } },
                { email: { contains: query, mode: "insensitive" } },
                { name: { contains: query, mode: "insensitive" } },
              ],
            },
          ],
        }
      : lifecycle,
    select: {
      id: true, email: true, username: true, name: true, firstName: true, lastName: true,
      title: true, role: true, accountKind: true, activatedAt: true, emailVerifiedAt: true,
      suspendedAt: true, recoveryRequiredAt: true, deletedAt: true, anonymizedAt: true,
      createdAt: true, lastLoginAt: true, passwordChangedAt: true, preferences: true,
      legalAcceptances: { orderBy: { acceptedAt: "desc" } },
      institution: { select: { id: true, name: true, city: true } },
    },
    orderBy: { createdAt: "desc" },
  })

  return NextResponse.json(users.map(({ preferences, legalAcceptances, ...account }) => {
    const preferredLocale = preferredLocaleFromPreferences(preferences)
    let legalCurrent: boolean | null = null
    try {
      const required = activeLegalDocuments(preferredLocale)
      legalCurrent = required.every(document => legalAcceptances.some(acceptance => (
        acceptance.deployment === document.deployment
        && acceptance.kind === document.kind
        && acceptance.documentVersion === document.version
        && acceptance.documentEffectiveAt.toISOString().slice(0, 10) === document.effectiveDate
        && acceptance.locale.toLowerCase() === document.locale
        && acceptance.contentSha256 === document.contentSha256
      )))
    } catch {
      legalCurrent = null
    }
    return {
      ...account,
      status: accountLifecycleStatus(account),
      preferredLocale,
      legalCurrent,
      legalAcceptances: legalAcceptances.map(mapLegalAcceptance),
      deletionDeadline: account.deletedAt && !account.anonymizedAt
        ? deletionDeadline(account.deletedAt).toISOString()
        : null,
    }
  }))
}
