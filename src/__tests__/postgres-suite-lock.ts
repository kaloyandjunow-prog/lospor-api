import { Client } from "pg"

/**
 * Makes PostgreSQL suites that change the same appliance-wide rows take turns
 * (2026-10-19). Vitest runs test files in parallel against one database; the
 * preop profile suite switches questions off while the preop answers suite
 * expects them on, and one in a few runs failed. A session advisory lock,
 * held on its own connection from beforeAll to afterAll, serialises the
 * suites that name the same lock and leaves every other suite parallel.
 */
export async function holdPostgresSuiteLock(name: string): Promise<() => Promise<void>> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [name])
  return async () => {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [name]).catch(() => undefined)
    await client.end()
  }
}
