import type {
  ResearchBenchmarkMetricId,
  ResearchBenchmarkRequest,
  ResearchBenchmarkResponse,
  ResearchCaseQueryResponse,
  ResearchComparisonRequest,
  ResearchComparisonResponse,
  ResearchDistributionId,
  ResearchMetadata,
  ResearchMetric,
  ResearchMetricId,
  ResearchQueryRequest,
  ResearchQueryResponse,
  ResearchQualityMapping,
  ResearchQualityResponse,
} from "@lospor/core/research"
import {
  RESEARCH_API_VERSION,
  RESEARCH_BENCHMARK_METRIC_IDS,
  RESEARCH_DISTRIBUTION_IDS,
  RESEARCH_EXPORT_FORMATS,
  RESEARCH_METRIC_IDS,
  RESEARCH_MIN_CELL_SIZE,
  discloseResearchCount,
  normalizeResearchCohort,
  researchPercent,
  shouldSuppressResearchBinary,
  shouldSuppressResearchCell,
} from "@lospor/core/research"
import type { Prisma } from "@/generated/prisma/client"
import { API_RELEASE_VERSION } from "@/lib/api-version"
import { prisma } from "@/lib/prisma"
import { compileResearchWhere } from "./cohort-where"
import {
  canInspectEntireQueryScope,
  metadataScope,
  metadataScopes,
  type ResearchContext,
} from "./access"
import {
  readAllResearchSummaries,
  readResearchCases,
  readResearchDistribution,
  readResearchMetrics,
} from "./repository"

const DEFAULT_METRICS: ResearchMetricId[] = [
  "caseCount",
  "meanAgeYears",
  "meanBmi",
  "meanDurationMinutes",
  "emergencyRate",
  "complicationRate",
  "ponvRate",
  "meanAldrete",
]

const DEFAULT_DISTRIBUTIONS: ResearchDistributionId[] = [
  "sex",
  "asa",
  "procedure",
  "technique",
  "disposition",
]

export async function researchMetadata(context: ResearchContext): Promise<ResearchMetadata> {
  const latest = await prisma.case.aggregate({
    where: context.caseScope,
    _max: { updatedAt: true },
  })
  return {
    apiVersion: RESEARCH_API_VERSION,
    source: "LOSPOR",
    sourceLabel: "LOSPOR normalized clinical database",
    sourceVersion: API_RELEASE_VERSION,
    generatedAt: new Date().toISOString(),
    dataFreshnessAt: latest._max.updatedAt?.toISOString() ?? null,
    scope: metadataScope(context),
    scopes: metadataScopes(context),
    permissions: context.permissions,
    suppressionThreshold: RESEARCH_MIN_CELL_SIZE,
    defaultCohort: normalizeResearchCohort(),
    // All fourteen are genuinely computed by /research/query and
    // /research/compare, so this list is accurate for what it names, and it
    // stays at all fourteen: narrowing it would withdraw nine metrics the query
    // endpoint answers correctly. What benchmarking can plot is a different and
    // smaller question, answered by its own field below.
    supportedMetrics: [...RESEARCH_METRIC_IDS],
    supportedBenchmarkMetrics: [...RESEARCH_BENCHMARK_METRIC_IDS],
    supportedDistributions: [...RESEARCH_DISTRIBUTION_IDS],
    supportedExports: [...RESEARCH_EXPORT_FORMATS],
  }
}

export async function runResearchQuery(
  request: ResearchQueryRequest,
  context: ResearchContext,
): Promise<ResearchQueryResponse> {
  const cohort = normalizeResearchCohort(request.cohort)
  const where = await compileResearchWhere(cohort, context)
  const metricIds = request.metrics?.length ? request.metrics : DEFAULT_METRICS
  const distributionIds = request.distributions?.length
    ? request.distributions
    : DEFAULT_DISTRIBUTIONS
  const total = await prisma.case.count({ where })
  const allowExact = canInspectEntireQueryScope(context)
  const [metrics, distributions] = await Promise.all([
    readResearchMetrics(where, metricIds, allowExact),
    Promise.all(distributionIds.map(id =>
      readResearchDistribution(where, id))),
  ])

  return {
    apiVersion: RESEARCH_API_VERSION,
    source: "LOSPOR",
    cohort,
    matchingCases: allowExact ? total : null,
    matchingCaseCount: discloseResearchCount(total, allowExact),
    metrics,
    distributions,
    cases: [],
    pagination: null,
    generatedAt: new Date().toISOString(),
  }
}

export async function runResearchCaseQuery(
  request: ResearchQueryRequest,
  context: ResearchContext,
): Promise<ResearchCaseQueryResponse> {
  const cohort = normalizeResearchCohort(request.cohort)
  const where = await compileResearchWhere(cohort, context)
  const result = await readResearchCases(where, request.pagination, request.sort)
  return {
    apiVersion: RESEARCH_API_VERSION,
    source: "LOSPOR",
    cohort,
    matchingCases: result.total,
    cases: result.cases,
    pagination: result.pagination,
    generatedAt: new Date().toISOString(),
  }
}

function metricDifference(left: ResearchMetric, right: ResearchMetric) {
  if (left.value === null || right.value === null) {
    return { absoluteDifference: null, relativeDifferencePercent: null }
  }
  const absoluteDifference = Math.round((right.value - left.value) * 100) / 100
  const relativeDifferencePercent = left.value === 0
    ? null
    : Math.round(((right.value - left.value) / Math.abs(left.value)) * 1000) / 10
  return { absoluteDifference, relativeDifferencePercent }
}

export async function compareResearchCohorts(
  request: ResearchComparisonRequest,
  context: ResearchContext,
): Promise<ResearchComparisonResponse> {
  const requested = request.metrics?.length ? request.metrics : DEFAULT_METRICS
  const [leftWhere, rightWhere] = await Promise.all([
    compileResearchWhere(normalizeResearchCohort(request.left), context),
    compileResearchWhere(normalizeResearchCohort(request.right), context),
  ])
  const allowExact = canInspectEntireQueryScope(context)
  const [leftCount, rightCount, leftMetrics, rightMetrics] = await Promise.all([
    prisma.case.count({ where: leftWhere }),
    prisma.case.count({ where: rightWhere }),
    readResearchMetrics(leftWhere, requested, allowExact),
    readResearchMetrics(rightWhere, requested, allowExact),
  ])
  const rightById = new Map(rightMetrics.map(item => [item.id, item]))

  return {
    leftCount: allowExact ? leftCount : null,
    rightCount: allowExact ? rightCount : null,
    leftCaseCount: discloseResearchCount(leftCount, allowExact),
    rightCaseCount: discloseResearchCount(rightCount, allowExact),
    metrics: leftMetrics.flatMap(left => {
      const right = rightById.get(left.id)
      return right
        ? [{ id: left.id, left, right, ...metricDifference(left, right) }]
        : []
    }),
    generatedAt: new Date().toISOString(),
  }
}

function benchmarkPeriod(date: string, interval: ResearchBenchmarkRequest["interval"]): string {
  const [year, month] = date.split("-").map(Number)
  if (interval === "year") return String(year)
  if (interval === "quarter") return `${year}-Q${Math.floor((month - 1) / 3) + 1}`
  return `${year}-${String(month).padStart(2, "0")}`
}

function previousBenchmarkPeriod(
  period: string,
  interval: ResearchBenchmarkRequest["interval"],
): string {
  if (interval === "year") return String(Number(period) - 1)
  if (interval === "quarter") {
    const [yearText, quarterText] = period.split("-Q")
    const year = Number(yearText)
    const quarter = Number(quarterText)
    return quarter === 1 ? `${year - 1}-Q4` : `${year}-Q${quarter - 1}`
  }
  const [yearText, monthText] = period.split("-")
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 2, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
}

type BenchmarkCases = Awaited<ReturnType<typeof readAllResearchSummaries>>

/**
 * Recorded/expected clinical field counts per case id, for `fieldCompleteness`.
 * Empty for every other metric, which does not read it.
 */
type BenchmarkFieldStatusCounts = Map<string, { complete: number; total: number }>

type BenchmarkEvaluation = {
  value: number | null
  /** The cell size suppression is judged on — always a count of cases. */
  validCount: number
  numerator?: number
}

type BenchmarkEvaluator = (
  cases: BenchmarkCases,
  fieldStatuses: BenchmarkFieldStatusCounts,
) => BenchmarkEvaluation

function mean(values: number[]): number | null {
  if (!values.length) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * One evaluator per metric benchmarking can plot, keyed by the shared contract
 * list so the two cannot drift.
 *
 * The type is exhaustive on purpose. Before this, an unhandled metric fell
 * through to `{ value: null }` while the surrounding code still reported a real
 * `caseCount` and `suppressed: false` — a chart that says "this institution
 * has 240 cases and none of them have this" when the truth is "nobody wrote
 * this evaluator". Adding an id to `RESEARCH_BENCHMARK_METRIC_IDS` without an
 * evaluator here is now a compile error, and removing one is too.
 */
const BENCHMARK_EVALUATORS: Record<ResearchBenchmarkMetricId, BenchmarkEvaluator> = {
  caseCount: cases => ({ value: cases.length, validCount: cases.length }),

  meanAgeYears: cases => {
    const values = cases.flatMap(item => item.ageYears === null ? [] : [item.ageYears])
    return { value: mean(values), validCount: values.length }
  },

  meanDurationMinutes: cases => {
    const values = cases.flatMap(item =>
      item.durationMinutes === null ? [] : [item.durationMinutes])
    return { value: mean(values), validCount: values.length }
  },

  // Cases carrying at least one complication, over cases in the group. This is
  // the same quantity `readResearchMetrics` reports for `complicationRate`,
  // which counts distinct case ids in CaseComplication over the case total.
  complicationRate: cases => {
    const numerator = cases.filter(item => item.complications > 0).length
    return { value: researchPercent(numerator, cases.length), validCount: cases.length, numerator }
  },

  // Pooled over clinical field rows: complete fields across the group divided
  // by recorded fields across the group.
  //
  // This used to be the unweighted mean of each case's own completeness
  // percentage, which is a different number from the one the query and compare
  // screens print under the same name. Two screens, one metric name, two
  // answers — and neither was labelled, so a researcher had no way to know
  // which they were reading. They now agree, on the aggregate path's
  // definition, for two reasons. It is the definition already published by
  // /research/query, /research/compare and /research/quality, so the benchmark
  // was the single dissenter. And a mean of per-case percentages silently
  // counts a case with no recorded fields at all as 0% complete, because
  // `completeness()` returns 0 for an empty list; pooling leaves such a case
  // out of both numerator and denominator, where it belongs.
  //
  // `validCount` stays a count of cases, not of field rows. Suppression asks
  // how many patients a cell exposes, and one case can carry forty field rows.
  fieldCompleteness: (cases, fieldStatuses) => {
    let complete = 0
    let total = 0
    for (const item of cases) {
      const counts = fieldStatuses.get(item.id)
      if (!counts) continue
      complete += counts.complete
      total += counts.total
    }
    return { value: researchPercent(complete, total), validCount: cases.length }
  },
}

function isBenchmarkMetric(id: ResearchMetricId): id is ResearchBenchmarkMetricId {
  return (RESEARCH_BENCHMARK_METRIC_IDS as readonly ResearchMetricId[]).includes(id)
}

/**
 * Per-case complete/recorded field counts, read only when the requested metric
 * needs them. The presence values that count as complete are the same two the
 * aggregate path uses.
 */
async function readBenchmarkFieldStatusCounts(
  where: Prisma.CaseWhereInput,
): Promise<BenchmarkFieldStatusCounts> {
  const rows = await prisma.clinicalFieldStatus.groupBy({
    by: ["caseId", "presence"],
    where: { case: where },
    _count: { _all: true },
  })
  const counts: BenchmarkFieldStatusCounts = new Map()
  for (const row of rows) {
    const entry = counts.get(row.caseId) ?? { complete: 0, total: 0 }
    entry.total += row._count._all
    if (row.presence === "PRESENT" || row.presence === "NOT_APPLICABLE") {
      entry.complete += row._count._all
    }
    counts.set(row.caseId, entry)
  }
  return counts
}

export async function benchmarkResearchCohort(
  request: ResearchBenchmarkRequest,
  context: ResearchContext,
): Promise<ResearchBenchmarkResponse> {
  // The request schema already refuses anything outside the benchmark list, so
  // this only fires for a caller that bypassed it. Refusing loudly is the point:
  // the alternative is the answer that used to be given — an unsuppressed chart
  // of nulls beside a genuine case count, indistinguishable from a real finding
  // of nothing.
  if (!isBenchmarkMetric(request.metric)) {
    throw new Error(
      `Metric "${request.metric}" cannot be benchmarked. ` +
      `Benchmarking supports: ${RESEARCH_BENCHMARK_METRIC_IDS.join(", ")}.`,
    )
  }
  const evaluate = BENCHMARK_EVALUATORS[request.metric]
  const requestedInstitutions = request.institutionIds?.length
    ? request.institutionIds.filter(id =>
        context.scopeKind === "ALL" || context.institutionIds.includes(id))
    : context.scopeKind === "ALL"
      ? []
      : context.institutionIds
  const where = await compileResearchWhere(normalizeResearchCohort(request.cohort), context)
  const scopedWhere: Prisma.CaseWhereInput = requestedInstitutions.length
    ? { AND: [where, { institutionId: { in: requestedInstitutions } }] }
    : where
  const rows = await readAllResearchSummaries(scopedWhere)
  const institutions = await prisma.institution.findMany({
    where: requestedInstitutions.length ? { id: { in: requestedInstitutions } } : undefined,
    select: { id: true, name: true },
  })
  const names = new Map(institutions.map(item => [item.id, item.name]))
  const caseInstitutions = await prisma.case.findMany({
    where: scopedWhere,
    select: { id: true, institutionId: true },
  })
  const institutionByCase = new Map(caseInstitutions.map(item => [item.id, item.institutionId]))
  const fieldStatuses = request.metric === "fieldCompleteness"
    ? await readBenchmarkFieldStatusCounts(scopedWhere)
    : new Map()
  const groups = new Map<string, typeof rows>()

  for (const row of rows) {
    if (!row.period) continue
    const institutionId = institutionByCase.get(row.id) ?? null
    const key = `${benchmarkPeriod(row.period, request.interval)}::${institutionId ?? "none"}`
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }

  const allowExact = canInspectEntireQueryScope(context)
  const basePoints = [...groups.entries()]
    .map(([key, cases]) => {
      const [period, institutionId] = key.split("::")
      const result = evaluate(cases, fieldStatuses)
      const suppressed = !allowExact && (result.numerator !== undefined
        ? shouldSuppressResearchBinary(result.numerator, result.validCount)
        : shouldSuppressResearchCell(result.validCount))
      const hideCountValue = request.metric === "caseCount" && !allowExact
      return {
        period,
        scopeKey: institutionId,
        ...(institutionId !== "none" ? {
          institutionId,
          institutionLabel: names.get(institutionId) ?? "Institution",
        } : {}),
        value: suppressed || hideCountValue ? null : result.value,
        caseCount: suppressed || !allowExact ? null : cases.length,
        caseCountDisclosure: discloseResearchCount(cases.length, allowExact),
        previousValue: null as number | null,
        absoluteChange: null as number | null,
        relativeChangePercent: null as number | null,
        suppressed,
      }
    })
    .sort((a, b) => a.period.localeCompare(b.period))
  const byPeriod = new Map(basePoints.map(point => [
    `${point.period}::${point.scopeKey}`,
    point,
  ]))
  const points = basePoints.map(point => {
    if (!request.compareWithPreviousPeriod) return point
    const previous = byPeriod.get(
      `${previousBenchmarkPeriod(point.period, request.interval)}::${point.scopeKey}`,
    )
    const previousValue = previous?.value ?? null
    if (point.value === null || previousValue === null) {
      return { ...point, previousValue }
    }
    const absoluteChange = Math.round((point.value - previousValue) * 100) / 100
    const relativeChangePercent = previousValue === 0
      ? null
      : Math.round(((point.value - previousValue) / Math.abs(previousValue)) * 1000) / 10
    return { ...point, previousValue, absoluteChange, relativeChangePercent }
  }).map(({ scopeKey: _scopeKey, ...point }) => point)

  return {
    metric: request.metric,
    interval: request.interval,
    points,
    generatedAt: new Date().toISOString(),
  }
}

type MappingDelegate = {
  groupBy(args: object): Promise<Array<{ mappingStatus: string; _count: { _all: number } }>>
}

async function qualityMapping(
  domain: string,
  delegate: MappingDelegate,
  where: object,
  allowExact: boolean,
): Promise<ResearchQualityMapping> {
  const rows = await delegate.groupBy({
    by: ["mappingStatus"],
    where,
    _count: { _all: true },
  })
  const count = (status: string) =>
    rows.find(row => row.mappingStatus === status)?._count._all ?? 0
  const mapped = count("MAPPED")
  const sourceOnly = count("SOURCE_ONLY")
  const unmapped = count("UNMAPPED")
  const total = mapped + sourceOnly + unmapped
  const suppressed = !allowExact && [mapped, sourceOnly, unmapped]
    .some(value => shouldSuppressResearchCell(value))
  return {
    domain,
    mapped: allowExact ? mapped : null,
    sourceOnly: allowExact ? sourceOnly : null,
    unmapped: allowExact ? unmapped : null,
    coverage: suppressed ? null : researchPercent(mapped, total),
    suppressed,
  }
}

export async function researchQuality(
  context: ResearchContext,
): Promise<ResearchQualityResponse> {
  const scope = context.caseScope
  const allowExact = canInspectEntireQueryScope(context)
  const [cases, fields, mappings] = await Promise.all([
    prisma.case.findMany({
      where: scope,
      select: {
        id: true,
        status: true,
        updatedAt: true,
        // Newest first, one row: a case may now hold several finalizations, and
        // drift is measured against the one currently in force.
        finalizations: {
          orderBy: { sequence: "desc" },
          take: 1,
          select: { finalizedAt: true },
        },
        intraop: { select: { startedAt: true, endedAt: true } },
      },
    }),
    prisma.clinicalFieldStatus.groupBy({
      by: ["section", "fieldKey", "presence"],
      where: { case: scope },
      _count: { _all: true },
      orderBy: [{ section: "asc" }, { fieldKey: "asc" }],
    }),
    Promise.all([
      qualityMapping("diagnosis", prisma.preopDiagnosis as unknown as MappingDelegate, { preop: { case: scope } }, allowExact),
      qualityMapping("procedure", prisma.preopProcedure as unknown as MappingDelegate, { preop: { case: scope } }, allowExact),
      qualityMapping("comorbidity", prisma.comorbidity as unknown as MappingDelegate, { preop: { case: scope } }, allowExact),
      qualityMapping("laboratory", prisma.labResult as unknown as MappingDelegate, { preop: { case: scope } }, allowExact),
      qualityMapping("medication", prisma.medication as unknown as MappingDelegate, { preop: { case: scope } }, allowExact),
      qualityMapping("complication", prisma.caseComplication as unknown as MappingDelegate, { case: scope }, allowExact),
      qualityMapping("selection", prisma.caseSelection as unknown as MappingDelegate, { case: scope }, allowExact),
    ]),
  ])
  const grouped = new Map<string, { section: string; field: string; present: number; absent: number; notApplicable: number }>()
  for (const row of fields) {
    const key = `${row.section}.${row.fieldKey}`
    const item = grouped.get(key) ?? {
      section: row.section,
      field: row.fieldKey,
      present: 0,
      absent: 0,
      notApplicable: 0,
    }
    if (row.presence === "PRESENT") item.present += row._count._all
    else if (row.presence === "NOT_APPLICABLE") item.notApplicable += row._count._all
    else item.absent += row._count._all
    grouped.set(key, item)
  }
  const finalized = cases.filter(item => item.status === "COMPLETE")
  const snapshotCount = finalized.filter(item => item.finalizations.length > 0).length
  const relationalDriftCount = finalized.filter(item =>
    item.finalizations[0] && item.updatedAt > item.finalizations[0].finalizedAt).length
  const impossibleTimelineCount = cases.filter(item =>
    item.intraop?.startedAt &&
    item.intraop?.endedAt &&
    item.intraop.endedAt < item.intraop.startedAt).length
  const finalizedSuppressed = !allowExact && shouldSuppressResearchBinary(finalized.length, cases.length)
  const snapshotSuppressed = !allowExact && shouldSuppressResearchBinary(snapshotCount, finalized.length)
  const driftSuppressed = !allowExact && shouldSuppressResearchBinary(relationalDriftCount, finalized.length)
  const timelineSuppressed = !allowExact && shouldSuppressResearchBinary(impossibleTimelineCount, cases.length)

  return {
    totalCases: allowExact ? cases.length : null,
    totalCaseCount: discloseResearchCount(cases.length, allowExact),
    finalizedCases: allowExact && !finalizedSuppressed ? finalized.length : null,
    snapshotCoverage: snapshotSuppressed
      ? null
      : researchPercent(snapshotCount, finalized.length),
    relationalDriftCases: allowExact && !driftSuppressed ? relationalDriftCount : null,
    impossibleTimelineCases: allowExact && !timelineSuppressed ? impossibleTimelineCount : null,
    suppressed: finalizedSuppressed || snapshotSuppressed || driftSuppressed || timelineSuppressed,
    fields: [...grouped.values()].map(item => {
      const denominator = item.present + item.notApplicable + item.absent
      const complete = item.present + item.notApplicable
      const suppressed = !allowExact && [item.present, item.notApplicable, item.absent]
        .some(value => shouldSuppressResearchCell(value))
      return {
        section: item.section,
        field: item.field,
        present: allowExact ? item.present : null,
        absent: allowExact ? item.absent : null,
        notApplicable: allowExact ? item.notApplicable : null,
        completeness: suppressed ? null : researchPercent(complete, denominator),
        suppressed,
      }
    }),
    mappings,
    generatedAt: new Date().toISOString(),
  }
}
