import { z } from "zod"
import {
  RESEARCH_CASE_STATUSES,
  RESEARCH_DISTRIBUTION_IDS,
  RESEARCH_EXPORT_FORMATS,
  RESEARCH_METRIC_IDS,
} from "@lospor/core/research"

const numberRangeSchema = z.object({
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
}).strict()

const dateRangeSchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
}).strict()

const stringList = z.array(z.string().trim().min(1).max(200)).max(100)

export const researchCohortSchema = z.object({
  version: z.literal(1).default(1),
  filters: z.object({
    statuses: z.array(z.enum(RESEARCH_CASE_STATUSES)).max(4).optional(),
    finalized: dateRangeSchema.optional(),
    ageYears: numberRangeSchema.optional(),
    bmi: numberRangeSchema.optional(),
    durationMinutes: numberRangeSchema.optional(),
    aldreteTotal: numberRangeSchema.optional(),
    painScore: numberRangeSchema.optional(),
    sex: stringList.optional(),
    asa: stringList.optional(),
    emergency: z.boolean().optional(),
    highRisk: z.boolean().optional(),
    ponv: z.boolean().optional(),
    diagnosisCodes: stringList.optional(),
    diagnosisText: z.string().trim().max(200).optional(),
    comorbidityCodes: stringList.optional(),
    comorbidityText: z.string().trim().max(200).optional(),
    procedureCodes: stringList.optional(),
    procedureText: z.string().trim().max(200).optional(),
    procedureGroups: stringList.optional(),
    techniques: stringList.optional(),
    positions: stringList.optional(),
    airwayDevices: stringList.optional(),
    monitoring: stringList.optional(),
    medications: stringList.optional(),
    atcCodes: stringList.optional(),
    complications: stringList.optional(),
    dispositions: stringList.optional(),
    mappingStatuses: stringList.optional(),
    minimumCompleteness: z.number().finite().min(0).max(100).optional(),
  }).strict().default({}),
}).strict()

export const researchQuerySchema = z.object({
  cohort: researchCohortSchema,
  savedCohortId: z.string().trim().min(1).optional(),
  pagination: z.object({
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(200).optional(),
  }).strict().optional(),
  metrics: z.array(z.enum(RESEARCH_METRIC_IDS)).optional(),
  distributions: z.array(z.enum(RESEARCH_DISTRIBUTION_IDS)).optional(),
  sort: z.object({
    field: z.enum(["finalizedAt", "ageYears", "durationMinutes", "asa"]),
    direction: z.enum(["asc", "desc"]),
  }).strict().optional(),
}).strict()

export const researchComparisonSchema = z.object({
  left: researchCohortSchema,
  right: researchCohortSchema,
  metrics: z.array(z.enum(RESEARCH_METRIC_IDS)).optional(),
}).strict()

export const researchBenchmarkSchema = z.object({
  cohort: researchCohortSchema,
  interval: z.enum(["month", "quarter", "year"]),
  metric: z.enum(RESEARCH_METRIC_IDS),
  compareWithPreviousPeriod: z.boolean().optional(),
  institutionIds: z.array(z.string().trim().min(1)).max(50).optional(),
}).strict()

export const savedCohortCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  visibility: z.enum(["PRIVATE", "INSTITUTION"]).default("PRIVATE"),
  definition: researchCohortSchema,
}).strict()

export const savedCohortPatchSchema = savedCohortCreateSchema.partial().strict()

export const researchExportCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  format: z.enum(RESEARCH_EXPORT_FORMATS),
  definition: researchCohortSchema,
}).strict()

export const researchGrantCreateSchema = z.object({
  userId: z.string().trim().min(1),
  institutionId: z.string().trim().min(1).nullable().optional(),
  allInstitutions: z.boolean().default(false),
  canInspectCases: z.boolean().default(true),
  canExport: z.boolean().default(false),
  canExportOmop: z.boolean().default(false),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict().refine(
  value => value.allInstitutions || !!value.institutionId,
  { message: "institutionId is required unless allInstitutions is true" },
)

export const researchGrantPatchSchema = z.object({
  canInspectCases: z.boolean().optional(),
  canExport: z.boolean().optional(),
  canExportOmop: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  revoked: z.boolean().optional(),
}).strict()
