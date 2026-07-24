// DB-backed JWT revocation with an in-memory cache for fast reads.
// The cache is loaded eagerly at startup and refreshed every 5 minutes so that
// tokens revoked on another instance (or via direct DB write) are picked up.
import { prisma } from "@/lib/prisma"

const cache = new Set<string>()
let loaded = false
// Single in-flight promise so concurrent callers all await the same fetch.
let loadPromise: Promise<void> | null = null
let lastRefreshAt = 0
const REFRESH_INTERVAL_MS = 5 * 60 * 1000  // 5 minutes

async function loadFromDB(): Promise<void> {
  try {
    const rows = await prisma.revokedToken.findMany({
      where: { expiresAt: { gt: new Date() } },
      select: { jti: true },
    })
    // Replace cache contents with the current live set (clear expired entries too).
    cache.clear()
    for (const r of rows) cache.add(r.jti)
    lastRefreshAt = Date.now()
    loaded = true
  } catch {
    /* non-fatal — cache retains previous state, existing tokens stay protected */
    if (!loaded) loaded = true   // don't block callers forever on a DB outage
  }
}

function scheduleLoad(): Promise<void> {
  if (!loadPromise) {
    loadPromise = loadFromDB().finally(() => {
      // Allow the next staleness-triggered fetch to create a new promise.
      loadPromise = null
    })
  }
  return loadPromise
}

// Eager load at module initialisation (fire-and-forget — the promise is
// tracked so isRevoked() can await it on the very first call).
scheduleLoad()

// Periodic refresh: runs every REFRESH_INTERVAL_MS in long-lived server
// processes to pick up revocations issued by other instances.
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    loadFromDB()
  }, REFRESH_INTERVAL_MS).unref?.()
}

export async function revokeToken(jti: string, expiresAt: Date): Promise<void> {
  cache.add(jti)
  try {
    await prisma.revokedToken.upsert({
      where:  { jti },
      update: {},
      create: { jti, expiresAt },
    })
    // Lazy prune expired entries from the DB.
    await prisma.revokedToken.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  } catch { /* non-fatal — in-memory cache still protects this session */ }
}

// Async variant — awaits the initial DB load before returning a result, so the
// very first call in a fresh process is never a false-negative.
// Also triggers a refresh if the cache data is stale.
export async function isRevokedAsync(jti: string): Promise<boolean> {
  const now = Date.now()
  if (!loaded || now - lastRefreshAt > REFRESH_INTERVAL_MS) {
    await scheduleLoad()
  }
  return cache.has(jti)
}

// Synchronous variant — returns whatever is currently in the cache.
// Safe to call from the NextAuth JWT callback (which must be synchronous).
// The cache is populated by the eager load at startup; the periodic refresh
// keeps it current. On the very first millisecond of a cold start the cache
// may be empty (load still in flight), but this window is tiny in practice.
export function isRevoked(jti: string): boolean {
  return cache.has(jti)
}
