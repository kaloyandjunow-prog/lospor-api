import { Prisma } from "@/generated/prisma/client"

export type AuthUser = {
  id: string
  role?: string | null
  institutionId?: string | null
}

type CaseAccessRecord = {
  userId: string
  createdById?: string | null
  institutionId?: string | null
  user?: Record<string, unknown> | null
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

export function canReadCase(user: AuthUser, record: CaseAccessRecord): boolean {
  if (user.role === "ADMIN") return true
  if (record.userId === user.id) return true
  if (user.role === "HEAD_OF_DEPT" && user.institutionId) {
    // The case's own institution, not the owner's. This used to fall back to
    // `record.user.institutionId` when the case had none, which handed a head
    // of department every unstamped case belonging to anyone who later joined
    // them. It must stay identical to headOfDeptCaseScope, or a list and a
    // detail view disagree about the same case.
    return record.institutionId === user.institutionId
  }
  if (
    record.createdById === user.id
    && !!user.institutionId
    && record.institutionId === user.institutionId
  ) return true
  return false
}

export function canWriteCase(user: AuthUser, record: CaseAccessRecord): boolean {
  if (user.role === "ADMIN") return true
  if (record.userId === user.id) return true
  return user.role === "HEAD_OF_DEPT"
    && !!user.institutionId
    && record.institutionId === user.institutionId
}

export function caseCapabilitiesForUser(user: AuthUser, record: CaseAccessRecord) {
  return {
    canRead: canReadCase(user, record),
    canWrite: canWriteCase(user, record),
    isCreator: record.createdById === user.id,
    isAssignee: record.userId === user.id,
  }
}

/** @deprecated Read alias retained while external consumers move to the explicit name. */
export const canAccessCase = canReadCase

/**
 * Kept for its call sites; it no longer falls back to the owner.
 *
 * Looking the owner up was how an unstamped case reached a head of department:
 * the answer depended on where its author happens to work *now*, so the same
 * case changed hands when its author moved. Registration requires an
 * institution and every case is stamped at creation, so there is nothing left
 * that needs the lookup, and an unstamped historical case stays with the
 * clinician who recorded it and with administrators.
 *
 * `db` is unused and retained so the call sites keep their transaction
 * argument; it can go when they are next touched.
 */
export async function canAccessCaseWithOwnerFallback(
  _db: Pick<Prisma.TransactionClient, "user">,
  user: AuthUser,
  record: CaseAccessRecord,
): Promise<boolean> {
  return canReadCase(user, record)
}

export async function canWriteCaseWithOwnerFallback(
  _db: Pick<Prisma.TransactionClient, "user">,
  user: AuthUser,
  record: CaseAccessRecord,
): Promise<boolean> {
  return canWriteCase(user, record)
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
  // Cases stamped with this institution, and only those.
  //
  // There used to be a second clause matching cases with no institution owned
  // by someone currently in this one. It was there because accounts could
  // exist without an institution, and it quietly undid the rule it sat beside:
  // a clinician who recorded cases while unaffiliated, then joined a
  // department, handed that department's head every case they had ever
  // recorded — work done elsewhere, before that hospital had anything to do
  // with them.
  //
  // Registration now requires an institution and every case is stamped at
  // creation, so nothing new lands unstamped. Cases still carrying no
  // institution stay visible to the clinician who recorded them and to
  // administrators, and to nobody else, which is the honest reading: they
  // belong to no department.
  return { institutionId }
}

export function caseReadWhereForUser(user: AuthUser, id?: string): Prisma.CaseWhereInput {
  const base = id ? { id } : {}
  if (user.role === "ADMIN") return base
  if (user.role === "HEAD_OF_DEPT" && user.institutionId) {
    return { ...base, ...headOfDeptCaseScope(user.institutionId) }
  }
  if (user.institutionId) {
    return {
      ...base,
      OR: [
        { userId: user.id },
        { createdById: user.id, institutionId: user.institutionId },
      ],
    }
  }
  return { ...base, userId: user.id }
}

export function caseWriteWhereForUser(user: AuthUser, id?: string): Prisma.CaseWhereInput {
  const base = id ? { id } : {}
  if (user.role === "ADMIN") return base
  if (user.role === "HEAD_OF_DEPT" && user.institutionId) {
    return { ...base, ...headOfDeptCaseScope(user.institutionId) }
  }
  return { ...base, userId: user.id }
}

/** @deprecated Read alias retained for compatibility; writes must never use it. */
export const caseWhereForUser = caseReadWhereForUser

/**
 * Who this person may hand a case to.
 *
 * Handing a case on is a peer act, not only a downward one: a shift ends, or a
 * pre-assessment is done days earlier by someone who will not be in that
 * theatre. So a member sees their department, and neither a member nor a head
 * is restricted to handing *down* — a registrar must be able to pass a case to
 * the consultant, which is the direction that matters most and the one this
 * returned `null` for.
 *
 * Account activation is required in every branch. An inactive account cannot
 * sign in, so making it the assignee of a clinical record would strand that
 * record with someone unable to touch it.
 *
 * Institution is the boundary in both non-admin branches, and it is load
 * bearing rather than cosmetic: a case may not move between hospitals at all
 * (see the note in case-transfer.ts), so offering a recipient who could only be
 * refused later would be offering a choice that cannot work.
 */
export function colleagueWhereForUser(user: AuthUser): Prisma.UserWhereInput | null {
  if (user.role === "ADMIN") {
    return {
      id: { not: user.id },
      accountKind: "CLINICAL",
      activatedAt: { not: null },
      suspendedAt: null,
      recoveryRequiredAt: null,
      deletedAt: null,
      anonymizedAt: null,
    }
  }
  if (user.institutionId) {
    return {
      institutionId: user.institutionId,
      id: { not: user.id },
      accountKind: "CLINICAL",
      activatedAt: { not: null },
      suspendedAt: null,
      recoveryRequiredAt: null,
      deletedAt: null,
      anonymizedAt: null,
    }
  }
  return null
}
