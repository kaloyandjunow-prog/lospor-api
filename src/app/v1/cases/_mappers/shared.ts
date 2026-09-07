// Types and coercion helpers shared by the preop, intraop and postop mappers.
import { Prisma } from "@/generated/prisma/client"
import type { ClinicalMode } from "@lospor/core/pediatric"


// Copies full[k] into r[k] for each key present in the raw payload. A plain
// `r[k] = full[k]` inside a loop over a key UNION can't statically prove the
// value type for a given k matches r's expected type at that same k (TS
// doesn't correlate union members across separate indexed accesses) — this
// generic signature binds K once per call so the assignment type-checks
// without a cast.
export function copyKey<T, K extends keyof T>(r: Partial<T>, full: T, k: K): void {
  r[k] = full[k]
}

// Mappers accept a deliberately permissive payload: canonical field names
// (matching the Prisma columns) plus legacy/mobile aliases (ulbt,
// difficultAirway, familyProblems, etc.) that predate the canonical names.
// Casting once here — instead of at each of the ~150 individual field reads
// below — keeps every `preop.x` read properly typed against the real column
// type while still tolerating the alias keys the rest of the function checks.
export type PreopRawInput = Partial<Prisma.PreoperativeAssessmentUncheckedCreateWithoutCaseInput> & {
  ulbt?: string
  difficultAirway?: boolean
  familyProblems?: boolean
  familyProblemNotes?: string | null
  diagnoses?: { label?: string; sub?: string; code?: string }[]
  procedures?: { label?: string; sub?: string; code?: string; group?: string; domain?: string; description?: string }[]
  allergyDetails?: string | { label?: string; inn?: string; atcCode?: string; dose?: string; route?: string; frequency?: string; source?: string }[] | null
  currentMedications?: string | { label?: string; inn?: string; atcCode?: string; dose?: string; route?: string; frequency?: string; source?: string }[] | null
  clinicalMode?: ClinicalMode
}

export type TaggedDrugList = PreopRawInput["currentMedications"] | PreopRawInput["allergyDetails"]

export function taggedListToStorage(value: TaggedDrugList): string | null {
  if (!Array.isArray(value)) return value ?? null
  const items = value
    .filter(item => item && (item.label || item.inn || item.atcCode))
    .map(item => ({
      label: item.label ?? item.inn ?? item.atcCode ?? "",
      inn: item.inn ?? undefined,
      atcCode: item.atcCode ?? undefined,
      dose: item.dose ?? undefined,
      route: item.route ?? undefined,
      frequency: item.frequency ?? undefined,
      // Provenance for this item — e.g. "ai-scan" for a med read off a photo.
      // Rebuilt from a fixed key list like the rest of this object, so a new
      // key silently vanishes here unless it is named explicitly.
      source: item.source ?? undefined,
    }))
  return items.length ? JSON.stringify(items) : null
}


// Return v if it is one of the allowed values, otherwise null.
// Prevents empty strings / unknown values from breaking Prisma enum fields.
export function safeEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return (allowed as readonly unknown[]).includes(v) ? (v as T) : null
}

export function toIntOrNull(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = parseInt(String(v), 10)
  return isNaN(n) ? null : n
}

export function toFloatOrNull(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = parseFloat(String(v))
  return isNaN(n) ? null : n
}

// For UPDATE operations: only include fields that were explicitly present in the payload.
// Using mapIntraop for updates fills in ?? defaults for every missing field, silently
// overwriting existing DB data with zeros/empty arrays on every partial save.
