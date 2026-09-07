import type { CaseRow, ExportQualityWarning } from "./types"

/**
 * The export's own data-quality checks, split out of omop-mapper.ts.
 *
 * Runs once per export over the full case list, after the per-case mapping
 * loop has built the mapping-summary counts. Independent of how any single
 * domain maps: this only reads what a case looked like going in and what got
 * counted coming out.
 */
export function buildQualityWarnings(
  cases: CaseRow[],
  mappingSummary: { mapped_rows: number; manually_curated_rows: number; rejected_rows: number; source_only_rows: number; unmapped_rows: number },
): ExportQualityWarning[] {
  const warnings: ExportQualityWarning[] = []

  // ── Error-level (FAIL) checks ──────────────────────────────────────────────

  const nonFinalizedCount = cases.filter(c => c.status !== "COMPLETE").length
  if (nonFinalizedCount > 0) {
    warnings.push({
      code: "NON_FINALIZED_CASES",
      severity: "error",
      message: "Export includes cases that have not been finalised (status !== COMPLETE). Research integrity requires finalised cases only.",
      count: nonFinalizedCount,
    })
  }

  const missingSnapshotCount = cases.filter(c =>
    c.status === "COMPLETE" && c.finalizations.length === 0).length
  if (missingSnapshotCount > 0) {
    warnings.push({
      code: "MISSING_FINALIZATION_SNAPSHOT",
      severity: "error",
      message: "Some finalised cases have no immutable snapshot. The snapshot is written at finalisation; its absence indicates a corrupted or interrupted finalisation.",
      count: missingSnapshotCount,
    })
  }

  const relationalDriftCount = cases.filter(c => {
    if (!c.updatedAt || !c.finalizedAt) return false
    return c.updatedAt.getTime() > c.finalizedAt.getTime() + 5_000
  }).length
  if (relationalDriftCount > 0) {
    warnings.push({
      code: "RELATIONAL_DRIFT",
      severity: "error",
      message: "Some cases were edited after finalisation (updatedAt > finalizedAt). The snapshot may not match the exported data.",
      count: relationalDriftCount,
    })
  }

  const impossibleTimestampCount = cases.filter(c => {
    const start = c.intraop?.startedAt ?? c.intraop?.startTime
    const end = c.intraop?.endedAt ?? c.intraop?.endTime
    if (!start || !end) return false
    return end < start
  }).length
  if (impossibleTimestampCount > 0) {
    warnings.push({
      code: "IMPOSSIBLE_TIMESTAMPS",
      severity: "error",
      message: "Some cases have intraoperative end time before start time, indicating a data entry error.",
      count: impossibleTimestampCount,
    })
  }

  // ── Warning-level checks ───────────────────────────────────────────────────

  const casesWithoutFieldStatus = cases.filter(c => (c.fieldStatuses ?? []).length === 0).length
  const exactTimestampRows = cases.reduce((sum, c) => sum + (c.events ?? []).length, 0)
  const freeTextComplications = cases.reduce((sum, c) => sum + (c.complications ?? []).filter(comp => Boolean(comp.note)).length, 0)
  // Counted from the case alone, matching what the export actually writes as
  // the care site. Counting the author's institution here would report cases as
  // institution-linked whose exported care site is null.
  const institutionLinked = cases.filter(c => Boolean(c.institutionId)).length

  if (mappingSummary.unmapped_rows > 0) {
    warnings.push({
      code: "UNMAPPED_CONCEPT_ROWS",
      severity: "warning",
      message: "Some normalized rows have no source or standard vocabulary mapping.",
      count: mappingSummary.unmapped_rows,
    })
  }
  if (mappingSummary.source_only_rows > 0) {
    warnings.push({
      code: "SOURCE_ONLY_CONCEPT_ROWS",
      severity: "info",
      message: "Some rows preserve source vocabulary/code without a confident OMOP standard concept ID.",
      count: mappingSummary.source_only_rows,
    })
  }
  if (casesWithoutFieldStatus > 0) {
    warnings.push({
      code: "NO_FIELD_STATUS_ROWS",
      severity: "error",
      message: "Some cases have no ClinicalFieldStatus rows. Field-level missingness cannot be determined; relational sync may not have run.",
      count: casesWithoutFieldStatus,
    })
  }
  if (exactTimestampRows > 0) {
    warnings.push({
      code: "EXACT_EVENT_TIMESTAMPS",
      severity: "info",
      message: "Intraoperative events retain exact timestamps for clinical sequence analysis; this is a residual linkage risk.",
      count: exactTimestampRows,
    })
  }
  if (institutionLinked > 0) {
    warnings.push({
      code: "INSTITUTION_LINKAGE",
      severity: "info",
      message: "Exports include care_site_source_value for research governance; small institutions can increase re-identification risk.",
      count: institutionLinked,
    })
  }
  if (freeTextComplications > 0) {
    warnings.push({
      code: "REDACTED_FREE_TEXT_PRESENT",
      severity: "warning",
      message: "Free-text complication notes existed and were passed through the export redaction pipeline. Review redacted output before sharing.",
      count: freeTextComplications,
    })
  }
  return warnings
}
