import { RATE_LIMIT_WINDOW_MS } from "@/lib/constants"
import { prisma } from "@/lib/prisma"

// The production Supabase project. Mirrors the guard in scripts/seed-e2e-user.ts:
// whatever else is misconfigured, nothing that points here gets test behaviour.
const PROD_PROJECT_REF = "yzqszvlvccyufrkbuhtv"

/**
 * Whether rate limiting is switched off for an automated test run.
 *
 * The end-to-end suite authenticates six accounts and signs in again in several
 * specs, all from one address, against a limit of ten per fifteen minutes. It
 * therefore exhausts a limit it imposed on itself, and the failure appears as a
 * login page that never navigates — which reads like a broken application.
 *
 * Turning a brute-force control off is not something to do casually, so the
 * opt-in is deliberately hard to reach by accident. It requires an explicit
 * variable, and is then refused outright in any of the three situations that
 * could mean "this is not a test": a production build, a Vercel deployment of
 * any kind, or a connection string pointing at the production project. The
 * appliance runs NODE_ENV=production, so it can never take effect there either.
 *
 * When it is active it says so on every start, because a security control that
 * is off silently is worse than one that is on.
 */
let announced = false

export function rateLimitingDisabledForTests(): boolean {
  if (process.env.LOSPOR_DISABLE_RATE_LIMIT !== "true") return false
  if (process.env.NODE_ENV === "production") return false
  if (process.env.VERCEL_ENV) return false
  if ((process.env.DATABASE_URL ?? "").includes(PROD_PROJECT_REF)) return false

  if (!announced) {
    announced = true
    console.warn("[rate-limit] DISABLED for testing — LOSPOR_DISABLE_RATE_LIMIT is set")
  }
  return true
}

// DB-backed, serverless-safe rate limiter. The previous in-memory Map reset per
// lambda instance, so limits were effectively unenforced in production. This uses
// a single atomic upsert (INSERT … ON CONFLICT … RETURNING) so concurrent requests
// across any number of instances share one counter and increment race-free.
//
// Window semantics match the old limiter: a fixed window that resets once
// `windowMs` has elapsed since `windowStart`.
export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number = RATE_LIMIT_WINDOW_MS,
): Promise<{ allowed: boolean; retryAfter: number }> {
  if (rateLimitingDisabledForTests()) return { allowed: true, retryAfter: 0 }

  const now = new Date()
  const threshold = new Date(now.getTime() - windowMs)

  try {
    const rows = await prisma.$queryRaw<{ count: number; windowStart: Date }[]>`
      INSERT INTO "RateLimit" ("key", "count", "windowStart")
      VALUES (${key}, 1, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimit"."windowStart" < ${threshold} THEN 1
                       ELSE "RateLimit"."count" + 1 END,
        "windowStart" = CASE WHEN "RateLimit"."windowStart" < ${threshold} THEN ${now}
                             ELSE "RateLimit"."windowStart" END
      RETURNING "count", "windowStart"
    `
    const row = rows[0]
    if (!row) return { allowed: true, retryAfter: 0 }

    const count = Number(row.count)
    if (count > limit) {
      const elapsed = now.getTime() - new Date(row.windowStart).getTime()
      const retryAfter = Math.max(1, Math.ceil((windowMs - elapsed) / 1000))
      return { allowed: false, retryAfter }
    }
    return { allowed: true, retryAfter: 0 }
  } catch {
    // Fail open on a DB hiccup — a brief outage must not lock everyone out of
    // login/registration. The window is short and the risk bounded.
    return { allowed: true, retryAfter: 0 }
  }
}
