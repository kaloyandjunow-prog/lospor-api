/**
 * Refuse to write to a protected database unless the operator names it.
 *
 * The maintenance scripts used to guard production with:
 *
 *   if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production")
 *
 * That reads like protection and is not. It describes the *environment the
 * process is running in*, not the *database it is connected to*. Running a
 * script from a laptop with DATABASE_URL pointed at production sails straight
 * past it — neither variable is set locally. Every script carrying that check
 * was one `DOTENV_CONFIG_PATH` away from writing to live clinical data while
 * claiming it refused to.
 *
 * This guard looks at the connection string instead, which is the thing that
 * actually decides which rows change.
 *
 * To act on a protected database you must name it exactly:
 *
 *   LOSPOR_ALLOW_PROTECTED_DB=<project-ref> npm run clinical-rules:...
 *
 * A blanket "yes" is deliberately not accepted. Naming the reference is a
 * different act from confirming a prompt: you cannot do it by reflex, and you
 * cannot do it while believing you are pointed somewhere else.
 */

/** Supabase project references that hold real clinical data. */
const DEFAULT_PROTECTED_REFS = ["yzqszvlvccyufrkbuhtv"]

/**
 * The Supabase project reference inside a connection string.
 *
 * Handles both the direct host (`db.<ref>.supabase.co`) and the pooler
 * (`...pooler.supabase.com`, where the ref is carried in the username as
 * `postgres.<ref>`). Returns null for anything else — a local cluster has no
 * reference and is never protected.
 */
export function databaseRefFrom(connectionString: string | undefined | null): string | null {
  if (!connectionString) return null
  const direct = connectionString.match(/@db\.([a-z0-9]{16,})\.supabase\./i)
  if (direct) return direct[1]
  const pooled = connectionString.match(/\/\/postgres\.([a-z0-9]{16,})[:@]/i)
  if (pooled) return pooled[1]
  return null
}

export function protectedRefs(): string[] {
  const extra = (process.env.LOSPOR_PROTECTED_DB_REFS ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
  return [...new Set([...DEFAULT_PROTECTED_REFS, ...extra])]
}

export function isProtectedDatabase(connectionString: string | undefined | null): boolean {
  const ref = databaseRefFrom(connectionString)
  return ref !== null && protectedRefs().includes(ref)
}

/**
 * Throws unless it is safe — or explicitly intended — to write to the database
 * this process is pointed at. Returns the detected reference so callers can
 * report which database they are about to touch.
 */
export function assertDatabaseWritable(action: string): { ref: string | null; protected: boolean } {
  const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")

  const ref = databaseRefFrom(connectionString)
  if (!isProtectedDatabase(connectionString)) return { ref, protected: false }

  if (process.env.LOSPOR_ALLOW_PROTECTED_DB !== ref) {
    throw new Error(
      `Refusing to ${action}: this connection points at protected database "${ref}".\n`
      + `If that is genuinely intended, re-run with:\n`
      + `  LOSPOR_ALLOW_PROTECTED_DB=${ref}\n`
      + `Naming the database is required; a generic override is not accepted.`,
    )
  }
  return { ref, protected: true }
}
