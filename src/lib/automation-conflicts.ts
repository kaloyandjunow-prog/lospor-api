import { canonicalTechnique } from "@lospor/core/intraop"
import type { LogEvent } from "@/types/timetable"

type JsonRecord = Record<string, unknown>

const recordOf = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null

const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string").map(canonicalTechnique)
  : []

const generalOrSedation = (code: string): boolean => code.startsWith("GENERAL_") || code.startsWith("SEDATION_")

/** Automation patches may be retried by two clients, but an inferred general
 * technique or block side must never be silently merged with a contradictory
 * answer from the other client. Explicit/manual writes do not use this guard;
 * the clinician's explicit selection remains authoritative. */
export function automationTechniqueConflict(
  current: JsonRecord | null | undefined,
  incoming: JsonRecord | null | undefined,
): { kind: "technique" | "side"; current: string; incoming: string } | null {
  const patch = recordOf(incoming)
  if (!patch) return null
  const currentTechniques = strings(current?.techniques)
  const incomingTechniques = strings(patch.techniques)
  const currentGeneral = currentTechniques.filter(generalOrSedation)
  const incomingGeneral = incomingTechniques.filter(generalOrSedation)
  const incomingSet = new Set(incomingGeneral)
  const conflictingGeneral = currentGeneral.find(code => !incomingSet.has(code))
  const incomingDifferentGeneral = incomingGeneral.find(code => currentGeneral.length > 0 && !currentGeneral.includes(code))
  if (conflictingGeneral && incomingDifferentGeneral) {
    return { kind: "technique", current: conflictingGeneral, incoming: incomingDifferentGeneral }
  }

  const currentSides = recordOf(current?.techniqueSides) ?? {}
  const incomingSides = recordOf(patch.techniqueSides) ?? {}
  for (const [code, side] of Object.entries(incomingSides)) {
    const previous = currentSides[code]
    if (typeof previous === "string" && typeof side === "string" && previous !== side) {
      return { kind: "side", current: previous, incoming: side }
    }
  }
  return null
}

/** Find a context-generated clinical event already created for the same source
 * action. This is intentionally narrow: ordinary explicit clinical events are
 * not coalesced just because they have the same label and timestamp. */
export function automationDuplicateClinicalEvent(
  current: readonly LogEvent[],
  candidate: LogEvent,
): LogEvent | null {
  if (candidate.type !== "clinical_event" || !candidate.suggestion?.startsWith("context:")) return null
  if (!candidate.clinicalRelation || !candidate.sourceEventId) return null
  return current.find(event => event.type === "clinical_event"
    && event.suggestion?.startsWith("context:")
    && event.clinicalRelation === candidate.clinicalRelation
    && event.sourceEventId === candidate.sourceEventId
    && event.label === candidate.label) ?? null
}

/** Preserve the first event identity while filling in a missing structured
 * patch on a duplicate context action. */
export function coalesceAutomationClinicalEvent(existing: LogEvent, candidate: LogEvent): LogEvent {
  const existingPatch = recordOf(existing.intraopPatch)
  const candidatePatch = recordOf(candidate.intraopPatch)
  return {
    ...existing,
    ...candidate,
    id: existing.id,
    ...(existingPatch || candidatePatch
      ? { intraopPatch: { ...(existingPatch ?? {}), ...(candidatePatch ?? {}) } }
      : {}),
  }
}

