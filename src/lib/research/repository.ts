import type {
  ResearchDistribution,
  ResearchDistributionId,
  ResearchMetric,
  ResearchMetricId,
  ResearchPaginationRequest,
} from "@lospor/core/research"
import {
  makeResearchPagination,
  researchPercent,
} from "@lospor/core/research"
import type { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import {
  RESEARCH_DETAIL_SELECT,
  RESEARCH_SUMMARY_SELECT,
  distribution,
  mapResearchDetail,
  mapResearchSummary,
  metric,
} from "./mappers"

export async function readResearchCases(
  where: Prisma.CaseWhereInput,
  pagination?: ResearchPaginationRequest,
  sort?: { field: "finalizedAt" | "ageYears" | "durationMinutes" | "asa"; direction: "asc" | "desc" },
) {
  const paging = makeResearchPagination(await prisma.case.count({ where }), pagination)
  const orderBy: Prisma.CaseOrderByWithRelationInput =
    !sort || sort.field === "finalizedAt"
      ? { finalizedAt: sort?.direction ?? "desc" }
      : sort.field === "ageYears"
        ? { preop: { ageYears: sort.direction } }
        : sort.field === "durationMinutes"
          ? { intraop: { durationMinutes: sort.direction } }
          : { preop: { asaScore: sort.direction } }

  const rows = await prisma.case.findMany({
    where,
    select: RESEARCH_SUMMARY_SELECT,
    orderBy,
    skip: paging.skip,
    take: paging.take,
  })

  return {
    total: paging.total,
    cases: rows.map(mapResearchSummary),
    pagination: paging,
  }
}

export async function readResearchCase(
  id: string,
  where: Prisma.CaseWhereInput,
) {
  const row = await prisma.case.findFirst({
    where: { AND: [where, { id }] },
    select: RESEARCH_DETAIL_SELECT,
  })
  return row ? mapResearchDetail(row) : null
}

async function countDistinctComplicationCases(where: Prisma.CaseWhereInput): Promise<number> {
  const rows = await prisma.caseComplication.findMany({
    where: { case: where },
    select: { caseId: true },
    distinct: ["caseId"],
  })
  return rows.length
}

async function mappingCounts(where: Prisma.CaseWhereInput) {
  const results = await Promise.all([
    prisma.preopDiagnosis.groupBy({
      by: ["mappingStatus"],
      where: { preop: { case: where } },
      _count: { _all: true },
    }),
    prisma.preopProcedure.groupBy({
      by: ["mappingStatus"],
      where: { preop: { case: where } },
      _count: { _all: true },
    }),
    prisma.comorbidity.groupBy({
      by: ["mappingStatus"],
      where: { preop: { case: where } },
      _count: { _all: true },
    }),
    prisma.labResult.groupBy({
      by: ["mappingStatus"],
      where: { preop: { case: where } },
      _count: { _all: true },
    }),
    prisma.medication.groupBy({
      by: ["mappingStatus"],
      where: { preop: { case: where } },
      _count: { _all: true },
    }),
  ])
  const counts = new Map<string, number>()
  for (const rows of results) {
    for (const row of rows) {
      counts.set(row.mappingStatus, (counts.get(row.mappingStatus) ?? 0) + row._count._all)
    }
  }
  return counts
}

async function completenessCounts(where: Prisma.CaseWhereInput) {
  const rows = await prisma.clinicalFieldStatus.groupBy({
    by: ["presence"],
    where: { case: where },
    _count: { _all: true },
  })
  const complete = rows
    .filter(row => row.presence === "PRESENT" || row.presence === "NOT_APPLICABLE")
    .reduce((sum, row) => sum + row._count._all, 0)
  const total = rows.reduce((sum, row) => sum + row._count._all, 0)
  return { complete, total }
}

export async function readResearchMetrics(
  where: Prisma.CaseWhereInput,
  requested: ResearchMetricId[],
  allowExactCounts = false,
): Promise<ResearchMetric[]> {
  const total = await prisma.case.count({ where })
  const requestedSet = new Set(requested)
  const [
    preopAverage,
    intraopAverage,
    postopAverage,
    emergencies,
    emergencyObserved,
    highRisk,
    highRiskObserved,
    ponv,
    postopObserved,
    complicationCases,
    mappings,
    fields,
  ] = await Promise.all([
    prisma.preoperativeAssessment.aggregate({
      where: { case: where },
      _avg: { ageYears: true, bmi: true },
      _count: { ageYears: true, bmi: true },
    }),
    prisma.intraoperativeRecord.aggregate({
      where: { case: where },
      _avg: { durationMinutes: true },
      _count: { durationMinutes: true },
    }),
    prisma.postoperativeRecord.aggregate({
      where: { case: where },
      _avg: { aldreteTotal: true, painScoreNRS: true },
      _count: { aldreteTotal: true, painScoreNRS: true },
    }),
    prisma.case.count({ where: { AND: [where, { preop: { is: { emergencySurgery: true } } }] } }),
    prisma.case.count({ where: { AND: [where, { preop: { isNot: null } }] } }),
    prisma.case.count({ where: { AND: [where, { preop: { is: { highRiskSurgery: true } } }] } }),
    prisma.case.count({ where: { AND: [where, { preop: { isNot: null } }] } }),
    prisma.case.count({ where: { AND: [where, { postop: { is: { ponv: true } } }] } }),
    prisma.case.count({ where: { AND: [where, { postop: { isNot: null } }] } }),
    countDistinctComplicationCases(where),
    mappingCounts(where),
    completenessCounts(where),
  ])
  const mapped = mappings.get("MAPPED") ?? 0
  const mappingTotal = [...mappings.values()].reduce((sum, count) => sum + count, 0)

  const all: ResearchMetric[] = [
    metric("caseCount", total, total, { unit: "count", hideExact: !allowExactCounts }),
    metric("meanAgeYears", preopAverage._avg.ageYears, preopAverage._count.ageYears, { unit: "years" }),
    metric("meanBmi", preopAverage._avg.bmi, preopAverage._count.bmi, { unit: "kg/m2" }),
    metric("meanDurationMinutes", intraopAverage._avg.durationMinutes, intraopAverage._count.durationMinutes, { unit: "minutes" }),
    metric("emergencyRate", researchPercent(emergencies, emergencyObserved), emergencyObserved, {
      numerator: emergencies,
      unit: "percent",
      binary: true,
    }),
    metric("highRiskRate", researchPercent(highRisk, highRiskObserved), highRiskObserved, {
      numerator: highRisk,
      unit: "percent",
      binary: true,
    }),
    metric("complicationRate", researchPercent(complicationCases, total), total, {
      numerator: complicationCases,
      unit: "percent",
      binary: true,
    }),
    metric("ponvRate", researchPercent(ponv, postopObserved), postopObserved, {
      numerator: ponv,
      unit: "percent",
      binary: true,
    }),
    metric("meanAldrete", postopAverage._avg.aldreteTotal, postopAverage._count.aldreteTotal, { unit: "score" }),
    metric("meanPainScore", postopAverage._avg.painScoreNRS, postopAverage._count.painScoreNRS, { unit: "score" }),
    metric("mappingCoverage", researchPercent(mapped, mappingTotal), mappingTotal, {
      numerator: mapped,
      unit: "percent",
      binary: true,
    }),
    metric("fieldCompleteness", researchPercent(fields.complete, fields.total), fields.total, {
      numerator: fields.complete,
      unit: "percent",
      binary: true,
    }),
  ]
  return all.filter(item => requestedSet.has(item.id))
}

function addBucket(
  buckets: Map<string, {
    label: string
    labelEn?: string
    labelBg?: string | null
    cases: Set<string>
  }>,
  key: string | null | undefined,
  label: string | null | undefined,
  caseId: string,
  labelBg?: string | null,
) {
  const normalized = key?.trim()
  if (!normalized) return
  const existing = buckets.get(normalized) ?? {
    label: label?.trim() || normalized,
    labelEn: label?.trim() || normalized,
    labelBg: labelBg?.trim() || null,
    cases: new Set<string>(),
  }
  existing.cases.add(caseId)
  buckets.set(normalized, existing)
}

export async function readResearchDistribution(
  where: Prisma.CaseWhereInput,
  id: ResearchDistributionId,
): Promise<ResearchDistribution> {
  const buckets = new Map<string, {
    label: string
    labelEn?: string
    labelBg?: string | null
    cases: Set<string>
  }>()

  if (id === "status") {
    const rows = await prisma.case.findMany({ where, select: { id: true, status: true } })
    for (const row of rows) addBucket(buckets, row.status, row.status, row.id)
  } else if (id === "sex" || id === "asa") {
    const rows = await prisma.preoperativeAssessment.findMany({
      where: { case: where },
      select: { caseId: true, sex: true, asaScore: true },
    })
    for (const row of rows) {
      const value = id === "sex" ? row.sex : row.asaScore
      addBucket(buckets, value, value, row.caseId)
    }
  } else if (id === "disposition") {
    const rows = await prisma.postoperativeRecord.findMany({
      where: { case: where },
      select: { caseId: true, disposition: true },
    })
    for (const row of rows) addBucket(buckets, row.disposition, row.disposition, row.caseId)
  } else if (id === "procedure") {
    const rows = await prisma.preopProcedure.findMany({
      where: { preop: { case: where } },
      select: { caseId: true, code: true, sourceCode: true, group: true, description: true },
    })
    for (const row of rows) {
      addBucket(
        buckets,
        row.code ?? row.sourceCode ?? row.group,
        row.group ?? row.description ?? row.code,
        row.caseId,
      )
    }
  } else if (id === "diagnosis") {
    const rows = await prisma.preopDiagnosis.findMany({
      where: { preop: { case: where } },
      select: {
        caseId: true,
        code: true,
        sourceCode: true,
        label: true,
        labelEn: true,
        labelBg: true,
      },
    })
    for (const row of rows) {
      addBucket(buckets, row.code ?? row.sourceCode, row.labelEn ?? row.label, row.caseId, row.labelBg)
    }
  } else if (id === "technique") {
    const rows = await prisma.caseSelection.findMany({
      where: { case: where, category: "technique" },
      select: { caseId: true, value: true },
    })
    for (const row of rows) addBucket(buckets, row.value, row.value, row.caseId)
  } else if (id === "airway") {
    const rows = await prisma.intraoperativeRecord.findMany({
      where: { case: where },
      select: { caseId: true, airwayDevice: true },
    })
    for (const row of rows) addBucket(buckets, row.airwayDevice, row.airwayDevice, row.caseId)
  } else {
    const rows = await prisma.caseComplication.findMany({
      where: { case: where },
      select: { caseId: true, sourceCode: true, label: true },
    })
    for (const row of rows) addBucket(buckets, row.sourceCode ?? row.label, row.label, row.caseId)
  }

  return distribution(id, buckets)
}

export async function readAllResearchSummaries(
  where: Prisma.CaseWhereInput,
): Promise<ReturnType<typeof mapResearchSummary>[]> {
  const result: ReturnType<typeof mapResearchSummary>[] = []
  let cursor: string | undefined
  while (true) {
    const rows = await prisma.case.findMany({
      where,
      select: RESEARCH_SUMMARY_SELECT,
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (!rows.length) break
    result.push(...rows.map(mapResearchSummary))
    cursor = rows.at(-1)?.id
  }
  return result
}
