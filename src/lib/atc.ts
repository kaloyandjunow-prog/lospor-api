/**
 * One WHO ATC code in its canonical form, or null when the value is not one.
 *
 * The Bulgarian drug list (src/data/drugs.json, scraped from the BDA register
 * by scripts/scrape-bda.mjs) carried every substance-level code as the register
 * page prints it -- "L01BC 2", not L01BC02. No ATC table, concept map or
 * research pack spells a code that way, so every home medication picked from
 * that list reached the concept map under a code nothing could match, and
 * exported concept 0 whether or not a terminology package was imported.
 *
 * Accepted: the five ATC levels (A, A01, A01A, A01AB, A01AB01), upper-cased,
 * and the register's "A01AB 1" / "A01AB 12" spelling of the fifth. Anything
 * else is not guessed at.
 */
export function normalizeAtcCode(value: unknown): string | null {
  if (typeof value !== "string") return null
  const text = value.trim().toUpperCase()
  if (!text) return null
  const spaced = text.match(/^([A-Z]\d{2}[A-Z]{2})\s*(\d{1,2})$/)
  if (spaced) return `${spaced[1]}${spaced[2].padStart(2, "0")}`
  return /^[A-Z](?:\d{2}(?:[A-Z](?:[A-Z])?)?)?$/.test(text) ? text : null
}
