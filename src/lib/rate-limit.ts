import { RATE_LIMIT_WINDOW_MS } from "@/lib/constants"
import { prisma } from "@/lib/prisma"

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
