import { ZipArchive } from "archiver"
import { PassThrough, Readable } from "node:stream"
import { NextRequest, NextResponse } from "next/server"
import type { Prisma } from "@/generated/prisma/client"
import { API_RELEASE_VERSION } from "@/lib/api-version"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { caseReadWhereForUser } from "@/lib/access-control"
import type { AuthUser } from "@/lib/mobile-auth"

export const runtime = "nodejs"

const PAGE_SIZE = 250
const EXPORT_FORMAT_VERSION = "1.0"

const CASE_EXPORT_INCLUDE = {
  institution: { select: { id: true, name: true, city: true, country: true } },
  preop: {
    include: {
      diagnoses: { orderBy: { ordinal: "asc" as const } },
      procedureRows: { orderBy: { ordinal: "asc" as const } },
      comorbidityRows: { orderBy: { ordinal: "asc" as const } },
      labRows: { orderBy: { ordinal: "asc" as const } },
      medications: { orderBy: [{ kind: "asc" as const }, { ordinal: "asc" as const }] },
    },
  },
  intraop: {
    include: {
      vascularAccessRows: { orderBy: { ordinal: "asc" as const } },
      premedicationRows: {
        orderBy: [{ phase: "asc" as const }, { ordinal: "asc" as const }],
      },
    },
  },
  postop: true,
  transfers: { orderBy: { createdAt: "asc" as const } },
  events: { orderBy: [{ timestamp: "asc" as const }, { id: "asc" as const }] },
  selections: {
    orderBy: [
      { section: "asc" as const },
      { category: "asc" as const },
      { ordinal: "asc" as const },
    ],
  },
  complications: {
    orderBy: [{ section: "asc" as const }, { ordinal: "asc" as const }],
  },
  fieldStatuses: { orderBy: [{ section: "asc" as const }, { fieldKey: "asc" as const }] },
  fieldChanges: { orderBy: [{ at: "asc" as const }, { id: "asc" as const }] },
  // Every finalization, oldest first, not just the one in force. This is the
  // subject's own copy of their data: if a case was corrected, the history of
  // what was attested to is part of what they are entitled to see.
  finalizations: { orderBy: { sequence: "asc" as const } },
} satisfies Prisma.CaseInclude

function lines<T>(rows: T[]): string {
  return rows.map(row => `${JSON.stringify(row)}\n`).join("")
}

async function* caseLines(user: AuthUser): AsyncGenerator<string> {
  let cursor: string | undefined
  for (;;) {
    const rows = await prisma.case.findMany({
      where: caseReadWhereForUser(user),
      include: CASE_EXPORT_INCLUDE,
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (rows.length === 0) return
    yield lines(rows)
    cursor = rows.at(-1)?.id
  }
}

async function* auditLines(userId: string): AsyncGenerator<string> {
  let cursor: string | undefined
  for (;;) {
    const rows = await prisma.auditLog.findMany({
      where: { userId },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (rows.length === 0) return
    yield lines(rows)
    cursor = rows.at(-1)?.id
  }
}

async function* roleRequestLines(userId: string): AsyncGenerator<string> {
  let cursor: string | undefined
  for (;;) {
    const rows = await prisma.roleRequest.findMany({
      where: { userId },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (rows.length === 0) return
    yield lines(rows)
    cursor = rows.at(-1)?.id
  }
}

async function* transferLines(userId: string): AsyncGenerator<string> {
  let cursor: string | undefined
  for (;;) {
    const rows = await prisma.caseTransfer.findMany({
      where: { OR: [{ fromUserId: userId }, { toUserId: userId }, { initiatedBy: userId }] },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (rows.length === 0) return
    yield lines(rows)
    cursor = rows.at(-1)?.id
  }
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const [account, caseCount, auditCount, roleRequestCount, transferCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        username: true,
        usernameCanonical: true,
        name: true,
        firstName: true,
        lastName: true,
        title: true,
        role: true,
        accountKind: true,
        institutionId: true,
        institution: { select: { id: true, name: true, city: true, country: true } },
        preferences: true,
        createdAt: true,
        activatedAt: true,
        emailVerifiedAt: true,
        acceptedTermsAt: true,
        acceptedPrivacyAt: true,
        termsVersion: true,
        legalAcceptances: { orderBy: { acceptedAt: "asc" } },
        lastLoginAt: true,
        passwordChangedAt: true,
        deletedAt: true,
      },
    }),
    prisma.case.count({ where: caseReadWhereForUser(user) }),
    prisma.auditLog.count({ where: { userId: user.id } }),
    prisma.roleRequest.count({ where: { userId: user.id } }),
    prisma.caseTransfer.count({
      where: { OR: [{ fromUserId: user.id }, { toUserId: user.id }, { initiatedBy: user.id }] },
    }),
  ])

  if (!account) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (account.deletedAt) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const generatedAt = new Date()
  const manifest = {
    format: "LOSPOR personal data export",
    formatVersion: EXPORT_FORMAT_VERSION,
    appVersion: API_RELEASE_VERSION,
    generatedAt: generatedAt.toISOString(),
    complete: true,
    files: {
      "account.json": { records: 1 },
      "cases.ndjson": { records: caseCount },
      "audit-log.ndjson": { records: auditCount },
      "role-requests.ndjson": { records: roleRequestCount },
      "case-transfers.ndjson": { records: transferCount },
    },
    intentionallyExcluded: [
      "password hashes",
      "email-verification and password-reset tokens",
      "session and token-revocation secrets",
      "rate-limit records",
      "temporary case-editing locks",
    ],
  }

  const archive = new ZipArchive({ zlib: { level: 6 } })
  const output = new PassThrough()
  archive.on("warning", (error: Error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") output.destroy(error)
  })
  archive.on("error", (error: Error) => output.destroy(error))
  archive.pipe(output)

  archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: "manifest.json" })
  archive.append(`${JSON.stringify(account, null, 2)}\n`, { name: "account.json" })
  archive.append(Readable.from(caseLines(user)), { name: "cases.ndjson" })
  archive.append(Readable.from(auditLines(user.id)), { name: "audit-log.ndjson" })
  archive.append(Readable.from(roleRequestLines(user.id)), { name: "role-requests.ndjson" })
  archive.append(Readable.from(transferLines(user.id)), { name: "case-transfers.ndjson" })
  void archive.finalize().catch((error: Error) => output.destroy(error))

  const date = generatedAt.toISOString().slice(0, 10)
  return new Response(Readable.toWeb(output) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="lospor-export-${date}.zip"`,
      "Cache-Control": "private, no-store",
    },
  })
}
