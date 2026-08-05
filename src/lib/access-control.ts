import { Prisma, UserRole } from "@/generated/prisma/client"

export type AuthUser = {
  id: string
  role?: string | null
  institutionId?: string | null
}

type CaseAccessRecord = {
  userId: string
  institutionId?: string | null
  user?: { institutionId?: string | null } | null
}

// Centralizes the `!user || user.role !== "X"` check that was copy-pasted
// across 14+ admin/case routes, so the role gate lives in one audited place.
// Typed as a predicate so callers keep `user` narrowed to non-null afterward,
// same as the inline `!user || ...` checks it replaces.
export function requireRole<U extends { role?: string | null }>(
  user: U | null | undefined, roles: string[]
): user is U {
  return !!user && !!user.role && roles.includes(user.role)
}

export function canAccessCase(user: AuthUser, record: CaseAccessRecord): boolean {
  if (user.role === "ADMIN") return true
  if (record.userId === user.id) return true
  if (user.role === "HEAD_OF_DEPT" && user.institutionId) {
    return (record.institutionId ?? record.user?.institutionId) === user.institutionId
  }
  return false
}

export async function canAccessCaseWithOwnerFallback(
  db: Pick<Prisma.TransactionClient, "user">,
  user: AuthUser,
  record: CaseAccessRecord,
): Promise<boolean> {
  if (canAccessCase(user, record)) return true
  if (user.role !== "HEAD_OF_DEPT" || !user.institutionId || record.institutionId != null) {
    return false
  }

  const owner = await db.user.findUnique({
    where: { id: record.userId },
    select: { institutionId: true },
  })
  return owner?.institutionId === user.institutionId
}

/**
 * A case belongs to the institution it was performed at.
 *
 * `Case.institutionId` is the snapshot taken when the case was created, and it
 * is the authority. The owner's *current* institution is only a fallback, for
 * historical rows recorded before the snapshot existed.
 *
 * This used to scope solely by the owner's current institution, which disagreed
 * with `canAccessCase` above. The consequence was clinical, not cosmetic: when a
 * colleague moved hospitals, the cases they had performed at the old one
 * vanished from that department's list and appeared in the new department's —
 * so a head of department could see case metadata for operations carried out
 * somewhere else entirely, and the department that did the work lost sight of
 * it.
 *
 * Exported so every route scopes identically. Anything hand-rolling this
 * predicate will drift from it again.
 */
export function headOfDeptCaseScope(institutionId: string): Prisma.CaseWhereInput {
  return {
    OR: [
      { institutionId },
      { institutionId: null, user: { institutionId } },
    ],
  }
}

export function caseWhereForUser(user: AuthUser, id?: string): Prisma.CaseWhereInput {
  const base = id ? { id } : {}
  if (user.role === "ADMIN") return base
  if (user.role === "HEAD_OF_DEPT" && user.institutionId) {
    return { ...base, ...headOfDeptCaseScope(user.institutionId) }
  }
  return { ...base, userId: user.id }
}

export function colleagueWhereForUser(user: AuthUser): Prisma.UserWhereInput | null {
  if (user.role === "ADMIN") {
    return { id: { not: user.id }, approvedAt: { not: null } }
  }
  if (user.role === "HEAD_OF_DEPT" && user.institutionId) {
    return { institutionId: user.institutionId, id: { not: user.id }, role: UserRole.MEMBER }
  }
  return null
}
