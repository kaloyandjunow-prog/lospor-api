import { timingSafeEqual } from "node:crypto"

/**
 * Comparing a presented secret against a configured one without leaking, in the
 * time taken, how much of it was right.
 *
 * `===` on strings returns as soon as two bytes differ, so the time it takes
 * tells an attacker how long a correct prefix they have, and a secret can be
 * recovered a byte at a time. It is a slow attack and a noisy one, but the fix
 * costs nothing and the alternative is arguing about how practical it is
 * against a machine that anonymises accounts.
 *
 * `/v1/internal/purge-deleted` compared its bearer with `===` while the
 * research-export worker beside it did this. Nothing distinguished them: they
 * are both internal endpoints holding a shared secret. Extracted here so the
 * next such route does not have to make the choice again.
 */
export function matchesSecret(presented: string, secret: string): boolean {
  const expectedBytes = Buffer.from(secret)
  const presentedBytes = Buffer.from(presented)
  // timingSafeEqual throws on mismatched lengths, so length is checked first
  // and does leak. That is unavoidable and not worth hiding: the length of a
  // generated secret is a property of the configuration, not of its value.
  return expectedBytes.length === presentedBytes.length
    && timingSafeEqual(expectedBytes, presentedBytes)
}

/** The token from an `Authorization: Bearer …` header, or "" when absent. */
export function bearerToken(request: Request): string {
  const header = request.headers.get("authorization")
  return header?.startsWith("Bearer ") ? header.slice(7) : ""
}
