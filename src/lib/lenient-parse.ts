import { z } from "zod"

export type RejectedField = {
  /** Dotted path, e.g. "preop.heightCm" — what the client should flag to the user. */
  path: string
  message: string
}

export type LenientParseResult<T> = {
  value: T
  rejected: RejectedField[]
}

/** Remove a nested key by path, returning a shallow-cloned object. */
function omitPath(input: unknown, path: readonly PropertyKey[]): unknown {
  if (path.length === 0 || input == null || typeof input !== "object") return input
  const [head, ...rest] = path
  if (Array.isArray(input)) {
    const idx = Number(head)
    if (!Number.isInteger(idx) || idx < 0 || idx >= input.length) return input
    const copy = input.slice()
    if (rest.length === 0) copy.splice(idx, 1)
    else copy[idx] = omitPath(copy[idx], rest)
    return copy
  }
  const src = input as Record<PropertyKey, unknown>
  if (!(head in src)) return input
  const copy: Record<PropertyKey, unknown> = { ...src }
  if (rest.length === 0) delete copy[head]
  else copy[head] = omitPath(copy[head], rest)
  return copy
}

/**
 * Parse `input`, dropping only the fields that fail validation instead of
 * rejecting the whole payload.
 *
 * Autosave sends the entire section on every keystroke-ish tick, so one
 * out-of-range value (a half-typed height, say) used to 400 the request and
 * discard every *other* edit in that same save. That reads to the clinician as
 * "autosave is broken". Here the valid fields still persist and the caller gets
 * back a list of what was refused, so the UI can say so rather than pretend the
 * value was stored.
 *
 * Only for autosave-style partial writes. Anything that must be complete and
 * correct (finalising a case) should keep using a strict `.parse()`.
 */
export function parseLenient<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
  maxPasses = 25,
): LenientParseResult<z.infer<T>> {
  let candidate = input
  const rejected: RejectedField[] = []

  for (let pass = 0; pass < maxPasses; pass++) {
    const result = schema.safeParse(candidate)
    if (result.success) return { value: result.data, rejected }

    // Drop every offending path this pass, then re-validate. Re-validation
    // matters: removing a field can surface a dependent issue (or resolve one).
    const issues = result.error.issues.filter(i => i.path.length > 0)
    if (issues.length === 0) throw result.error // whole-body failure — not salvageable

    let next = candidate
    for (const issue of issues) {
      const dotted = issue.path.join(".")
      if (!rejected.some(r => r.path === dotted)) {
        rejected.push({ path: dotted, message: issue.message })
      }
      next = omitPath(next, issue.path)
    }
    if (next === candidate) throw result.error // made no progress — bail rather than loop
    candidate = next
  }

  // Ran out of passes: treat as unsalvageable rather than silently saving a
  // payload we never managed to validate.
  throw new Error("parseLenient: exceeded maximum passes")
}
