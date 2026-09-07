import { createHash } from "node:crypto"

/**
 * Row-id counter and pseudonymous-id derivation, split out of omop-mapper.ts.
 *
 * `nextId`/`resetIds` are the module-level counter every row id in the export
 * is drawn from; `pseudonymId` is the deterministic hash that stands in for a
 * real patient/visit identifier. Both are stateless with respect to a single
 * case and are shared across every domain the mapper emits, which is what
 * earns them their own module rather than living beside one domain's rows.
 */

let _counter = 1
export function nextId() { return _counter++ }
export function resetIds(start = 1) { _counter = start }

// Optional deployment-wide salt. Keep it stable: changing it changes every
// pseudonym, so two exports taken either side of a change cannot be related.
const PSEUDONYM_SALT = process.env.OMOP_PSEUDONYM_SALT ?? ""

/**
 * Deterministic pseudonymous ID, derived from SHA-256.
 *
 * Takes 52 bits of the digest — the widest value that stays an exact JavaScript
 * integer. Collision becomes likely (birthday bound) somewhere past 60 million
 * cases rather than the ~70 thousand of the previous 32-bit string hash, which
 * would have silently merged two unrelated operations into one "person".
 *
 * `kind` namespaces the id so a case's person and visit ids can never coincide.
 */
export function pseudonymId(kind: string, key: string): number {
  const digest = createHash("sha256").update(`${PSEUDONYM_SALT}|${kind}|${key}`).digest()
  const hi = digest.readUInt32BE(0)         // 32 bits
  const lo = digest.readUInt32BE(4) >>> 12  // top 20 bits of the next word
  return hi * 0x100000 + lo + 1             // 52 bits, never zero
}
