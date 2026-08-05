import type { Prisma } from "@/generated/prisma/client"
import type { AuthUser } from "@/lib/access-control"

/**
 * Who may see and decide a request to change institution.
 *
 * The predicate keys on the **requested** institution, not the requester's
 * current one. That distinction is the whole point: approving the request is
 * what admits someone to a department and lets its head see their cases, so it
 * is the receiving head of department whose consent is needed. Keying on the
 * institution they are leaving would let a head of department post people into
 * departments they have no authority over.
 *
 * Returns a `where` fragment to merge into the query, or null when the caller
 * may not act on these at all.
 */
export function institutionRequestScope(
  user: AuthUser | null | undefined,
): Prisma.InstitutionChangeRequestWhereInput | null {
  if (!user?.id) return null
  if (user.role === "ADMIN") return {}
  if (user.role === "HEAD_OF_DEPT" && user.institutionId) {
    return { requestedInstitutionId: user.institutionId }
  }
  return null
}
