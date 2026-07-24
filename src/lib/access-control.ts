import { Prisma, UserRole } from "@/generated/prisma/client"

type AuthUser = {
  id: string
  role?: string | null
  institutionId?: string | null
}

type CaseAccessRecord = {
  userId: string
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
    return record.user?.institutionId === user.institutionId
  }
  return false
}

export function caseWhereForUser(user: AuthUser, id?: string): Prisma.CaseWhereInput {
  const base = id ? { id } : {}
  if (user.role === "ADMIN") return base
  if (user.role === "HEAD_OF_DEPT" && user.institutionId) {
    return { ...base, user: { institutionId: user.institutionId } }
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
