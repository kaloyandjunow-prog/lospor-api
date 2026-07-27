import type {
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
    sourceVersion: "7.2.0",
    generatedAt: new Date().toISOString(),
    dataFreshnessAt: latest._max.updatedAt?.toISOString() ?? null,
    scope: metadataScope(context),
    scopes: metadataScopes(context),
    permissions: context.permissions,
    suppressionThreshold: RESEARCH_MIN_CELL_SIZE,
    defaultCohort: normalizeResearchCohort(),
    supportedMetrics: [...RESEARCH_METRIC_IDS],
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

function benchmarkValue(
  metricId: ResearchMetricId,
  cases: Awaited<ReturnType<typeof readAllResearchSummaries>>,
): { value: number | null; validCount: number; numerator?: number } {
  if (metricId === "caseCount") {
    return { value: cases.length, validCount: cases.length }
  }
  if (metricId === "meanAgeYears") {
    const values = cases.flatMap(item => item.ageYears === null ? [] : [item.ageYears])
    return {
      value: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      validCount: values.length,
    }
  }
  if (metricId === "meanDurationMinutes") {
    const values = cases.flatMap(item => item.durationMinutes === null ? [] : [item.durationMinutes])
    return {
      value: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      validCount: values.length,
    }
  }
  if (metricId === "complicationRate") {
    const numerator = cases.filter(item => item.complications > 0).length
    return {
      value: researchPercent(numerator, cases.length),
      validCount: cases.length,
      numerator,
    }
  }
  if (metricId === "fieldCompleteness") {
    return {
      value: cases.length
        ? cases.reduce((sum, item) => sum + item.completeness, 0) / cases.length
        : null,
      validCount: cases.length,
    }
  }
  return { value: null, validCount: 0 }
}

export async function benchmarkResearchCohort(
  request: ResearchBenchmarkRequest,
  context: ResearchContext,
): Promise<ResearchBenchmarkResponse> {
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
      const result = benchmarkValue(request.metric, cases)
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
        snapshot: { select: { finalizedAt: true } },
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
  const snapshotCount = finalized.filter(item => !!item.snapshot).length
  const relationalDriftCount = finalized.filter(item =>
    item.snapshot && item.updatedAt > item.snapshot.finalizedAt).length
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
