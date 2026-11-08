import { AIRWAY_RECORD_PATCH_KEYS } from "@lospor/core/airway-smart"
import { intraopSchema } from "@/lib/schemas/case"
import { checkClinicalPayloadPII, piiErrorBody } from "@/lib/clinical-pii"

/**
 * What a clinical event may change in the intraoperative record when the two
 * travel together: the airway, the vascular lines and the technique with its
 * side. Everything else (start and end, gases, notes elsewhere) has its own
 * route with its own checks; the end of a case, for one, needs a reason and is
 * audited there. A key outside this list is dropped, not refused, so an older
 * client's queued event still lands as an event.
 */
export const ATOMIC_INTRAOP_PATCH_KEYS: readonly string[] = Object.freeze([
  ...AIRWAY_RECORD_PATCH_KEYS,
  "cormackLehane", "ventilationModes", "airwayNotes", "presentsIntubated",
  "vascularAccesses",
  "techniques", "techniqueSides",
])

const ALLOWED = new Set(ATOMIC_INTRAOP_PATCH_KEYS)

export type AtomicIntraopPatchInput =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; status: 400; body: Record<string, unknown> }

/** Validate an event's attached record change, keep only the keys it may carry, and screen its free text. */
export function atomicIntraopPatchFrom(raw: unknown): AtomicIntraopPatchInput {
  const parsed = intraopSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "Invalid structured intraop change",
        issues: parsed.error.issues.map(issue => ({ field: issue.path.join("."), message: issue.message })),
      },
    }
  }
  const patch = Object.fromEntries(Object.entries(parsed.data as Record<string, unknown>)
    .filter(([key]) => ALLOWED.has(key)))
  // The same screen for identifying text the section save applies to these fields.
  const pii = checkClinicalPayloadPII({ intraop: patch })
  if (pii) return { ok: false, status: 400, body: piiErrorBody(pii) as Record<string, unknown> }
  return { ok: true, patch }
}
