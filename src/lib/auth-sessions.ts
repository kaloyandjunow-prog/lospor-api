import "server-only"
import type { Prisma, PrismaClient } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"

type SessionDb = PrismaClient | Prisma.TransactionClient

export type AuthSessionClient = "WEB" | "PWA" | "NATIVE"

export const SESSION_LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000

export function normalizeDeviceLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, 120)
  return normalized || fallback
}

export async function createAuthSessionInTransaction(
  db: SessionDb,
  input: {
    jti: string
    userId: string
    clientType: AuthSessionClient
    deviceLabel: string
    issuedAt: Date
    expiresAt: Date
  },
): Promise<void> {
  await db.authSession.create({ data: input })
}

/**
 * Validate a 1.2.0+ session against its server-side row.
 *
 * Absence fails closed for tokens carrying the tracked-session claim. Legacy
 * tokens issued before the migration do not carry that claim and age out after
 * their original eight-hour TTL.
 */
export async function validateTrackedSession(jti: string, userId: string): Promise<boolean> {
  const now = new Date()
  const session = await prisma.authSession.findUnique({
    where: { jti },
    select: { userId: true, revokedAt: true, expiresAt: true, lastSeenAt: true },
  }).catch(() => null)

  if (!session || session.userId !== userId || session.revokedAt || session.expiresAt <= now) {
    return false
  }

  if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_LAST_SEEN_WRITE_INTERVAL_MS) {
    await prisma.authSession.updateMany({
      where: { jti, userId, revokedAt: null, expiresAt: { gt: now } },
      data: { lastSeenAt: now },
    }).catch(() => undefined)
  }
  return true
}

export async function revokeAllSessionsInTransaction(
  db: SessionDb,
  userId: string,
  now: Date,
  reason: string,
  exceptJti?: string | null,
): Promise<number> {
  const result = await db.authSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: now },
      ...(exceptJti ? { jti: { not: exceptJti } } : {}),
    },
    data: { revokedAt: now, revokedReason: reason },
  })
  return result.count
}

export async function revokeTrackedSession(
  jti: string,
  userId: string,
  now: Date,
  reason: string,
): Promise<boolean> {
  const result = await prisma.authSession.updateMany({
    where: { jti, userId, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  })
  return result.count === 1
}
