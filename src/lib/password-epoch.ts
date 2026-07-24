// Per-account security state consulted on every authenticated request:
// whether the account still exists, whether its tokens have been invalidated,
// and what role it currently holds.
//
// Previously this eagerly loaded *every* user with a passwordChangedAt into
// memory on each lambda boot and every 5 minutes thereafter. Fine at 50 users,
// a landmine at 50 000 — the work grew with the size of the register rather
// than with traffic. It now reads a single row on demand and caches it briefly,
// so cost scales with active users instead.
import { prisma } from "@/lib/prisma"

type AccountState = {
  passwordChangedAt: number | null
  deletedAt: number | null
  role: string | null
  institutionId: string | null
  institutionName: string | null
  complete: boolean
  fetchedAt: number
}

const cache = new Map<string, AccountState>()
const inflight = new Map<string, Promise<AccountState | null>>()

// Short enough that a deletion or demotion takes effect promptly, long enough
// that a busy request path is not a query per request.
const ENTRY_TTL_MS = 60 * 1000

function fresh(e: AccountState | undefined): e is AccountState {
  return !!e && Date.now() - e.fetchedAt < ENTRY_TTL_MS
}

function freshComplete(e: AccountState | undefined): e is AccountState {
  return fresh(e) && e.complete
}

async function fetchState(userId: string): Promise<AccountState | null> {
  const existing = inflight.get(userId)
  if (existing) return existing
  const p = (async () => {
    try {
      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          passwordChangedAt: true,
          deletedAt: true,
          role: true,
          institutionId: true,
          institution: { select: { name: true } },
        },
      })
      if (!u) return null
      const state: AccountState = {
        passwordChangedAt: u.passwordChangedAt?.getTime() ?? null,
        deletedAt:         u.deletedAt?.getTime() ?? null,
        role:              u.role ?? null,
        institutionId:     u.institutionId ?? null,
        institutionName:   u.institution?.name ?? null,
        complete:          true,
        fetchedAt:         Date.now(),
      }
      cache.set(userId, state)
      return state
    } catch {
      // DB blip: fall back to whatever we already knew rather than locking
      // everyone out. A stale entry is still safer than failing open on delete,
      // because the entry we hold was itself authoritative when fetched.
      return cache.get(userId) ?? null
    } finally {
      inflight.delete(userId)
    }
  })()
  inflight.set(userId, p)
  return p
}

/** Record a password change (or account deletion) NOW, priming this instance. */
export function notePasswordChanged(userId: string, changedAt: Date): void {
  const prev = cache.get(userId)
  cache.set(userId, {
    passwordChangedAt: changedAt.getTime(),
    deletedAt:         prev?.deletedAt ?? null,
    role:              prev?.role ?? null,
    institutionId:     prev?.institutionId ?? null,
    institutionName:   prev?.institutionName ?? null,
    complete:          prev?.complete ?? false,
    fetchedAt:         Date.now(),
  })
}

/** Drop a cached entry so the next check re-reads it (used after role changes). */
export function invalidateAccountState(userId: string): void {
  cache.delete(userId)
}

/**
 * Pure check, exported for tests: was the token (iat in SECONDS, as in JWT
 * claims) issued before the epoch (ms)?
 */
export function issuedBeforeEpoch(iatSeconds: number | undefined, epochMs: number | undefined | null): boolean {
  if (!epochMs) return false // user never reset — all tokens acceptable
  if (iatSeconds == null) return true // epoch set but token has no iat — treat as stale
  return iatSeconds * 1000 < epochMs
}

export type ResolvedAccount = {
  /** Current role from the database, not the (possibly hours-old) token claim. */
  role: string | null
  institutionId: string | null
  institutionName: string | null
}

/**
 * Authoritative account check for bearer and web session paths. Returns `null` when the
 * token must be refused: unknown account, deleted account, or issued before the
 * password epoch. Otherwise returns the live role, so demoting an administrator
 * takes effect within the cache TTL instead of persisting for the token's
 * remaining lifetime.
 */
export async function resolveAccount(userId: string, iatSeconds: number | undefined): Promise<ResolvedAccount | null> {
  const cached = cache.get(userId)
  const state = freshComplete(cached) ? cached : await fetchState(userId)
  if (!state) return null
  if (state.deletedAt !== null) return null
  if (issuedBeforeEpoch(iatSeconds, state.passwordChangedAt)) return null
  return { role: state.role, institutionId: state.institutionId, institutionName: state.institutionName }
}

/** Async variant kept for callers that only need the staleness answer. */
export async function isIssuedBeforePasswordChangeAsync(userId: string, iatSeconds: number | undefined): Promise<boolean> {
  return (await resolveAccount(userId, iatSeconds)) === null
}

/**
 * Sync variant — cache-only, for the NextAuth JWT callback which cannot await.
 * A cold instance has an empty cache and will accept the token; request paths
 * that can await re-validate against the database before using session claims.
 */
export function isIssuedBeforePasswordChange(userId: string, iatSeconds: number | undefined): boolean {
  const e = cache.get(userId)
  if (!e) return false
  if (e.deletedAt !== null) return true
  return issuedBeforeEpoch(iatSeconds, e.passwordChangedAt)
}
