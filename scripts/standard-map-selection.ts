export type AthenaSourceConcept = {
  conceptId: number
  conceptCode: string
  conceptName: string
  vocabularyId: string
  standardConcept: string | null
}

export type AthenaMapsToRelationship = {
  conceptId1: number
  conceptId2: number
}

export type AthenaStandardTarget = {
  conceptId: number
  conceptName: string
  vocabularyId: string
}

export type StandardConceptMapping = {
  standardVocabulary: string
  standardConceptId: number
  standardLabel: string
  mappingMethod: "athena-exact-standard-code" | "athena-exact-code-maps-to" | "bundled-icd10pcs-standard" | "bundled-icd10pcs-maps-to" | "bundled-icd10-maps-to" | "bundled-loinc-standard" | "bundled-atc-maps-to"
  mappingConfidence: number
  athenaVersion: string | null
}

export type StandardMapResolution =
  | { kind: "mapped"; standard: StandardConceptMapping }
  | {
      kind: "source-only"
      mappingMethod:
        | "athena-exact-source-code-not-found"
        | "athena-no-active-standard-target"
        | "athena-multiple-standard-targets"
      mappingNotes: string
      athenaVersion: string | null
      /** Present for athena-multiple-standard-targets: every distinct target, ascending. */
      targetIds?: number[]
    }

type SelectionInput = {
  vocabularyId: string
  codes: string[]
  sourceConcepts: AthenaSourceConcept[]
  relationships: AthenaMapsToRelationship[]
  targets: Map<number, AthenaStandardTarget>
  athenaVersion: string | null
}

/**
 * Select only mappings that resolve an exact source code to one distinct active
 * OMOP standard concept. Multiple `Maps to` rows can be an intentional OMOP
 * decomposition; LOSPOR's single-concept operational fields cannot represent
 * that honestly, so they remain source-only instead of taking the first row.
 */
export function selectStandardMapResolutions(input: SelectionInput): Map<string, StandardMapResolution> {
  const requestedCodes = [...new Set(input.codes.filter(Boolean))]
  const sourcesByCode = new Map<string, AthenaSourceConcept[]>()
  const sourceById = new Map<number, AthenaSourceConcept>()
  const candidatesByCode = new Map<string, Map<number, StandardConceptMapping>>()

  const addCandidate = (code: string, candidate: StandardConceptMapping) => {
    const candidates = candidatesByCode.get(code) ?? new Map<number, StandardConceptMapping>()
    if (!candidates.has(candidate.standardConceptId)) candidates.set(candidate.standardConceptId, candidate)
    candidatesByCode.set(code, candidates)
  }

  for (const source of input.sourceConcepts) {
    sourceById.set(source.conceptId, source)
    const sources = sourcesByCode.get(source.conceptCode) ?? []
    sources.push(source)
    sourcesByCode.set(source.conceptCode, sources)
    if (source.standardConcept === "S") {
      addCandidate(source.conceptCode, {
        standardVocabulary: source.vocabularyId,
        standardConceptId: source.conceptId,
        standardLabel: source.conceptName,
        mappingMethod: "athena-exact-standard-code",
        mappingConfidence: 1,
        athenaVersion: input.athenaVersion,
      })
    }
  }

  for (const relationship of input.relationships) {
    const source = sourceById.get(relationship.conceptId1)
    const target = input.targets.get(relationship.conceptId2)
    if (!source || !target) continue
    addCandidate(source.conceptCode, {
      standardVocabulary: target.vocabularyId,
      standardConceptId: target.conceptId,
      standardLabel: target.conceptName,
      mappingMethod: "athena-exact-code-maps-to",
      mappingConfidence: 0.95,
      athenaVersion: input.athenaVersion,
    })
  }

  const resolutions = new Map<string, StandardMapResolution>()
  for (const code of requestedCodes) {
    const sources = sourcesByCode.get(code) ?? []
    const candidates = candidatesByCode.get(code) ?? new Map<number, StandardConceptMapping>()
    if (sources.length === 0) {
      resolutions.set(code, {
        kind: "source-only",
        mappingMethod: "athena-exact-source-code-not-found",
        mappingNotes: `No active Athena ${input.vocabularyId} concept exists for the exact source code.`,
        athenaVersion: input.athenaVersion,
      })
    } else if (candidates.size === 0) {
      resolutions.set(code, {
        kind: "source-only",
        mappingMethod: "athena-no-active-standard-target",
        mappingNotes: "The active exact Athena source concept has no active standard target.",
        athenaVersion: input.athenaVersion,
      })
    } else if (candidates.size > 1) {
      const targetIds = [...candidates.keys()].sort((left, right) => left - right)
      resolutions.set(code, {
        kind: "source-only",
        mappingMethod: "athena-multiple-standard-targets",
        mappingNotes: `Athena supplies ${targetIds.length} distinct active standard targets (${targetIds.join(", ")}); no target was selected.`,
        athenaVersion: input.athenaVersion,
        targetIds,
      })
    } else {
      resolutions.set(code, { kind: "mapped", standard: [...candidates.values()][0] })
    }
  }
  return resolutions
}
