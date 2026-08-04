import type { ResearchCohortDefinition } from "@lospor/core/research"
import { normalizeResearchCohort } from "@lospor/core/research"
import type { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import type { ResearchContext } from "./access"

function numberFilter(range: { min?: number; max?: number } | undefined) {
  if (!range) return undefined
  return {
    ...(range.min !== undefined ? { gte: range.min } : {}),
    ...(range.max !== undefined ? { lte: range.max } : {}),
  }
}

function textContains(value: string | undefined) {
  return value ? { contains: value, mode: "insensitive" as const } : undefined
}

function exclusiveUtcDayEnd(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date
}

async function completenessCaseIds(minimum: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ caseId: string }>>`
    SELECT "caseId"
    FROM "ClinicalFieldStatus"
    GROUP BY "caseId"
    HAVING (
      100.0 * COUNT(*) FILTER (
        WHERE "presence" IN ('PRESENT', 'NOT_APPLICABLE')
      ) / NULLIF(COUNT(*), 0)
    ) >= ${minimum}
  `
  return rows.map(row => row.caseId)
}

export async function compileResearchWhere(
  definition: ResearchCohortDefinition,
  context: ResearchContext,
): Promise<Prisma.CaseWhereInput> {
  const { filters } = normalizeResearchCohort(definition)
  const preop: Prisma.PreoperativeAssessmentWhereInput = {}
  const intraop: Prisma.IntraoperativeRecordWhereInput = {}
  const postop: Prisma.PostoperativeRecordWhereInput = {}
  const and: Prisma.CaseWhereInput[] = [context.caseScope]
  if (filters.clinicalModes?.length) and.push({ clinicalMode: { in: filters.clinicalModes } })
  if (filters.ageDays) preop.ageApproxDays = numberFilter(filters.ageDays)
  if (filters.ageYears) preop.ageYears = numberFilter(filters.ageYears)
  if (filters.bmi) preop.bmi = numberFilter(filters.bmi)
  if (filters.sex?.length) preop.sex = { in: filters.sex as never }
  if (filters.asa?.length) preop.asaScore = { in: filters.asa as never }
  if (filters.emergency !== undefined) preop.emergencySurgery = filters.emergency
  if (filters.highRisk !== undefined) preop.highRiskSurgery = filters.highRisk

  if (filters.diagnosisCodes?.length || filters.diagnosisText) {
    preop.diagnoses = {
      some: {
        OR: [
          ...(filters.diagnosisCodes?.length ? [
            { code: { in: filters.diagnosisCodes } },
            { sourceCode: { in: filters.diagnosisCodes } },
          ] : []),
          ...(filters.diagnosisText ? [
            { label: textContains(filters.diagnosisText) },
            { labelEn: textContains(filters.diagnosisText) },
            { labelBg: textContains(filters.diagnosisText) },
          ] : []),
        ],
      },
    }
  }

  if (filters.comorbidityCodes?.length || filters.comorbidityText) {
    preop.comorbidityRows = {
      some: {
        OR: [
          ...(filters.comorbidityCodes?.length ? [
            { code: { in: filters.comorbidityCodes } },
            { icd10Code: { in: filters.comorbidityCodes } },
            { sourceCode: { in: filters.comorbidityCodes } },
          ] : []),
          ...(filters.comorbidityText ? [
            { label: textContains(filters.comorbidityText) },
            { labelEn: textContains(filters.comorbidityText) },
            { labelBg: textContains(filters.comorbidityText) },
          ] : []),
        ],
      },
    }
  }

  if (filters.procedureCodes?.length || filters.procedureText || filters.procedureGroups?.length) {
    preop.procedureRows = {
      some: {
        AND: [
          ...(filters.procedureCodes?.length ? [{
            OR: [
              { code: { in: filters.procedureCodes } },
              { sourceCode: { in: filters.procedureCodes } },
            ],
          }] : []),
          ...(filters.procedureText ? [{
            OR: [
              { description: textContains(filters.procedureText) },
              { group: textContains(filters.procedureText) },
            ],
          }] : []),
          ...(filters.procedureGroups?.length
            ? [{ group: { in: filters.procedureGroups } }]
            : []),
        ],
      },
    }
  }

  if (filters.medications?.length || filters.atcCodes?.length) {
    preop.medications = {
      some: {
        OR: [
          ...(filters.medications?.flatMap(value => [
            { nameRaw: textContains(value) },
            { inn: textContains(value) },
          ]) ?? []),
          ...(filters.atcCodes?.length ? [{ atcCode: { in: filters.atcCodes } }] : []),
        ],
      },
    }
  }

  if (filters.durationMinutes) intraop.durationMinutes = numberFilter(filters.durationMinutes)
  if (filters.airwayDevices?.length) {
    and.push({
      OR: [
        { intraop: { is: { airwayDevice: { in: filters.airwayDevices as never } } } },
        { selections: { some: { category: "airwayDevice", value: { in: filters.airwayDevices } } } },
      ],
    })
  }
  if (filters.aldreteTotal) postop.aldreteTotal = numberFilter(filters.aldreteTotal)
  if (filters.painScore) postop.painScoreNRS = numberFilter(filters.painScore)
  if (filters.ponv !== undefined) postop.ponv = filters.ponv
  if (filters.dispositions?.length) postop.disposition = { in: filters.dispositions as never }

  if (Object.keys(preop).length) and.push({ preop: { is: preop } })
  if (Object.keys(intraop).length) and.push({ intraop: { is: intraop } })
  if (Object.keys(postop).length) and.push({ postop: { is: postop } })

  if (filters.finalized?.from || filters.finalized?.to) {
    and.push({
      finalizedAt: {
        ...(filters.finalized.from ? { gte: new Date(`${filters.finalized.from}T00:00:00.000Z`) } : {}),
        ...(filters.finalized.to ? { lt: exclusiveUtcDayEnd(filters.finalized.to) } : {}),
      },
    })
  }

  for (const [category, values] of [
    ["technique", filters.techniques],
    ["position", filters.positions],
    ["monitoring", filters.monitoring],
  ] as const) {
    if (values?.length) {
      and.push({ selections: { some: { category, value: { in: values } } } })
    }
  }

  if (filters.complications?.length) {
    and.push({
      complications: {
        some: {
          OR: filters.complications.map(value => ({ label: textContains(value) })),
        },
      },
    })
  }

  if (filters.mappingStatuses?.length) {
    and.push({
      OR: [
        { preop: { is: { diagnoses: { some: { mappingStatus: { in: filters.mappingStatuses as never } } } } } },
        { preop: { is: { procedureRows: { some: { mappingStatus: { in: filters.mappingStatuses as never } } } } } },
        { preop: { is: { comorbidityRows: { some: { mappingStatus: { in: filters.mappingStatuses as never } } } } } },
      ],
    })
  }

  if (filters.minimumCompleteness !== undefined) {
    const caseIds = await completenessCaseIds(filters.minimumCompleteness)
    and.push({ id: { in: caseIds } })
  }

  return {
    AND: [
      ...and,
      { status: { in: filters.statuses as never } },
    ],
  }
}
