import type {
  ResearchBenchmarkRequest,
  ResearchBenchmarkResponse,
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
  normalizeResearchCohort,
  researchPercent,
  shouldSuppressResearchCell,
} from "@lospor/core/research"
import type { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { compileResearchWhere } from "./cohort-where"
import { metadataScope, type ResearchContext } from "./access"
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
    sourceVersion: "7.1.0",
    generatedAt: new Date().toISOString(),
    dataFreshnessAt: latest._max.updatedAt?.toISOString() ?? null,
    scope: metadataScope(context),
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
  const cases = await readResearchCases(where, request.pagination, request.sort)
  const [metrics, distributions] = await Promise.all([
    readResearchMetrics(where, metricIds),
    Promise.all(distributionIds.map(id =>
      readResearchDistribution(where, id, cases.total))),
  ])

  return {
    apiVersion: RESEARCH_API_VERSION,
    source: "LOSPOR",
    cohort,
    matchingCases: cases.total,
    metrics,
    distributions,
    cases: cases.cases,
    pagination: cases.pagination,
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
  const [leftCount, rightCount, leftMetrics, rightMetrics] = await Promise.all([
    prisma.case.count({ where: leftWhere }),
    prisma.case.count({ where: rightWhere }),
    readResearchMetrics(leftWhere, requested),
    readResearchMetrics(rightWhere, requested),
  ])
  const rightById = new Map(rightMetrics.map(item => [item.id, item]))

  return {
    leftCount,
    rightCount,
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

function benchmarkValue(
  metricId: ResearchMetricId,
  cases: Awaited<ReturnType<typeof readAllResearchSummaries>>,
): number | null {
  if (metricId === "caseCount") return cases.length
  if (metricId === "meanAgeYears") {
    const values = cases.flatMap(item => item.ageYears === null ? [] : [item.ageYears])
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  }
  if (metricId === "meanDurationMinutes") {
    const values = cases.flatMap(item => item.durationMinutes === null ? [] : [item.durationMinutes])
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  }
  if (metricId === "complicationRate") {
    return researchPercent(cases.filter(item => item.complications > 0).length, cases.length)
  }
  if (metricId === "fieldCompleteness") {
    return cases.length
      ? cases.reduce((sum, item) => sum + item.completeness, 0) / cases.length
      : null
  }
  return null
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

  return {
    metric: request.metric,
    interval: request.interval,
    points: [...groups.entries()]
      .map(([key, cases]) => {
        const [period, institutionId] = key.split("::")
        const suppressed = shouldSuppressResearchCell(cases.length)
        return {
          period,
          ...(institutionId !== "none" ? {
            institutionId,
            institutionLabel: names.get(institutionId) ?? "Institution",
          } : {}),
          value: suppressed ? null : benchmarkValue(request.metric, cases),
          caseCount: suppressed ? null : cases.length,
          suppressed,
        }
      })
      .sort((a, b) => a.period.localeCompare(b.period)),
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
  return {
    domain,
    mapped,
    sourceOnly,
    unmapped,
    coverage: researchPercent(mapped, mapped + sourceOnly + unmapped) ?? 0,
  }
}

export async function researchQuality(
  context: ResearchContext,
): Promise<ResearchQualityResponse> {
  const scope = context.caseScope
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
      qualityMapping("diagnosis", prisma.preopDiagnosis as unknown as MappingDelegate, { preop: { case: scope } }),
      qualityMapping("procedure", prisma.preopProcedure as unknown as MappingDelegate, { preop: { case: scope } }),
      qualityMapping("comorbidity", prisma.comorbidity as unknown as MappingDelegate, { preop: { case: scope } }),
      qualityMapping("laboratory", prisma.labResult as unknown as MappingDelegate, { preop: { case: scope } }),
      qualityMapping("medication", prisma.medication as unknown as MappingDelegate, { preop: { case: scope } }),
      qualityMapping("complication", prisma.caseComplication as unknown as MappingDelegate, { case: scope }),
      qualityMapping("selection", prisma.caseSelection as unknown as MappingDelegate, { case: scope }),
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

  return {
    totalCases: cases.length,
    finalizedCases: finalized.length,
    snapshotCoverage: researchPercent(
      finalized.filter(item => !!item.snapshot).length,
      finalized.length,
    ) ?? 0,
    relationalDriftCases: finalized.filter(item =>
      item.snapshot && item.updatedAt > item.snapshot.finalizedAt).length,
    impossibleTimelineCases: cases.filter(item =>
      item.intraop?.startedAt &&
      item.intraop?.endedAt &&
      item.intraop.endedAt < item.intraop.startedAt).length,
    fields: [...grouped.values()].map(item => ({
      ...item,
      completeness: researchPercent(
        item.present + item.notApplicable,
        item.present + item.notApplicable + item.absent,
      ) ?? 0,
    })),
    mappings,
    generatedAt: new Date().toISOString(),
  }
}
