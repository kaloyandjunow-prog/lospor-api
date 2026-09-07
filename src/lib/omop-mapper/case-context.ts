import type {
  OmopCareSite, OmopCondition, OmopDevice, OmopDrug, OmopLabRow, OmopMeasurement,
  OmopObservation, OmopObservationPeriod, OmopPerson, OmopProcedure, OmopVisit,
} from "./types"
import type { AIRWAY_GRADES } from "./concepts"

/**
 * Everything one case's worth of domain mappers (./domains/*) needs: the ids
 * and dates computed once per case, the shared row-emitting closures that
 * close over them, and the export-wide output arrays every domain appends to.
 *
 * Built once per case in `mapCasesToOmop`, immediately before the domain
 * mappers run in sequence over it -- splitting the mapper into files is safe
 * only because every domain reads and writes through this one shape rather
 * than each closing over its own slice of the per-case state.
 */
export type CaseMapperCtx = {
  personId: number
  visitId: number
  startDate: string | null
  endDate: string | null
  startDateTime: string | null
  endDateTime: string | null
  /** The case's institution, and its pseudonym -- both null when unrecorded. */
  careSite: string | null
  careSiteId: number | null

  // Export-wide accumulators. Every domain pushes into the same arrays; the
  // case loop does not copy or merge per-case results afterward.
  persons: OmopPerson[]
  observationPeriods: OmopObservationPeriod[]
  visits: OmopVisit[]
  conditions: OmopCondition[]
  drugs: OmopDrug[]
  measurements: OmopMeasurement[]
  procedures: OmopProcedure[]
  devices: OmopDevice[]
  observations: OmopObservation[]

  /** Tallies MAPPED/MANUALLY_CURATED/REJECTED/UNMAPPED/SOURCE_ONLY across every domain. */
  trackMapping: (status: string | null | undefined) => void
  /** `sourceVocabulary:sourceCode - label`, or a LOSPOR-namespaced fallback. */
  sourceValue: (prefix: string, sourceVocabulary?: string | null, sourceCode?: string | null, label?: string | null) => string
  /** A LOSPOR-namespaced OBSERVATION row, skipped when `value` is null/empty. */
  sourceObservation: (
    source: string,
    value: string | number | boolean | null | undefined,
    date?: string | null,
    numericValue?: number | null,
    conceptId?: number,
    valueConceptId?: number,
  ) => void
  /** A numeric MEASUREMENT row with a concept and a unit, skipped when `value` is null. */
  sourceMeasurement: (
    source: string,
    value: number | null | undefined,
    conceptId: number,
    unitConceptId: number,
    unitSourceValue: string | null,
    date?: string | null,
  ) => void
  /** Laboratory results -> MEASUREMENT, shared by the preop and intraop draws. */
  emitLabRows: (rows: OmopLabRow[], fallbackDate: string | null) => void
  /** Cuffed/uncuffed tracheal tube, as the LOINC-coded answer pair. */
  cuffedObservation: (source: string, cuffed: boolean | null | undefined) => void
  /** Mallampati/Cormack-Lehane, as a graded-scale MEASUREMENT. */
  emitAirwayGrade: (
    key: keyof typeof AIRWAY_GRADES,
    grade: string | null | undefined,
    date: string | null,
    notAssessable: boolean,
  ) => void
}

export type { OmopCareSite }
