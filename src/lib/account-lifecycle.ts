import type { Prisma } from "@/generated/prisma/client"
import { RETENTION_DAYS } from "@/lib/purge-deleted"

export const activeClinicalAdminWhere = {
  role: "ADMIN",
  accountKind: "CLINICAL",
  activatedAt: { not: null },
  suspendedAt: null,
  recoveryRequiredAt: null,
  deletedAt: null,
  anonymizedAt: null,
} as const satisfies Prisma.UserWhereInput

export type AccountLifecycleStatus =
  | "INVITED"
  | "ACTIVE"
  | "SUSPENDED"
  | "DELETION_PENDING"
  | "RECOVERY_REQUIRED"
  | "ANONYMIZED"

export function accountLifecycleStatus(account: {
  activatedAt: Date | null
  suspendedAt: Date | null
  recoveryRequiredAt: Date | null
  deletedAt: Date | null
  anonymizedAt: Date | null
}): AccountLifecycleStatus {
  if (account.anonymizedAt) return "ANONYMIZED"
  if (account.deletedAt) return "DELETION_PENDING"
  if (account.suspendedAt) return "SUSPENDED"
  if (account.recoveryRequiredAt) return "RECOVERY_REQUIRED"
  if (!account.activatedAt) return "INVITED"
  return "ACTIVE"
}

export function deletionDeadline(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000)
}

export function isTransactionConflict(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "P2034"
}

export const serializableTransaction = { isolationLevel: "Serializable" as const }
