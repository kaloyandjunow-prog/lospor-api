import { z } from "zod"
import {
  RESEARCH_BENCHMARK_METRIC_IDS,
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
    clinicalModes: z.array(z.enum(["ADULT", "PEDIATRIC"])).optional(),
    ageDays: numberRangeSchema.optional(),
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
    field: z.enum(["finalizedAt", "ageYears", "ageDays", "durationMinutes", "asa"]),
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
  // Deliberately narrower than `RESEARCH_METRIC_IDS`. Benchmarking evaluates a
  // metric per period and per institution, and only these five have an
  // evaluator. The other nine used to be accepted here and answered with an
  // unsuppressed chart of nulls beside a real case count, which reads as a
  // finding — this institution recorded none of these — rather than as a
  // feature that was never built. A 400 naming the supported metrics is the
  // honest answer, and it is what lets the browser build its picker from the
  // contract instead of a hand-kept list.
  metric: z.enum(RESEARCH_BENCHMARK_METRIC_IDS, {
    error: `metric must be one of: ${RESEARCH_BENCHMARK_METRIC_IDS.join(", ")}. `
      + "Other metrics are available on /research/query but cannot be plotted over time.",
  }),
  compareWithPreviousPeriod: z.boolean().optional(),
  institutionIds: z.array(z.string().trim().min(1)).max(50).optional(),
}).strict()

export const savedCohortCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  visibility: z.enum(["PRIVATE", "INSTITUTION"]).default("PRIVATE"),
  institutionId: z.string().trim().min(1).nullable().optional(),
  definition: researchCohortSchema,
}).strict()

export const savedCohortPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  visibility: z.enum(["PRIVATE", "INSTITUTION"]).optional(),
  institutionId: z.string().trim().min(1).nullable().optional(),
  definition: researchCohortSchema.optional(),
  expectedUpdatedAt: z.string().datetime().optional(),
}).strict()

export const researchExportCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  format: z.enum(RESEARCH_EXPORT_FORMATS),
  definition: researchCohortSchema,
}).strict()

export const researchGrantCreateSchema = z.object({
  userId: z.string().trim().min(1),
  institutionId: z.string().trim().min(1).nullable().optional(),
  allInstitutions: z.boolean().default(false),
  canQuery: z.boolean().default(true),
  canInspectCases: z.boolean().default(false),
  canExport: z.boolean().default(false),
  canExportOmop: z.boolean().default(false),
  canShareCohorts: z.boolean().default(false),
  expiresAt: z.string().datetime().optional(),
}).strict().superRefine((value, context) => {
  if (!value.allInstitutions && !value.institutionId) {
    context.addIssue({ code: "custom", message: "institutionId is required unless allInstitutions is true" })
  }
  if (!value.canQuery) {
    context.addIssue({ code: "custom", path: ["canQuery"], message: "query permission is required for a research grant" })
  }
  if (value.canExportOmop && !value.canExport) {
    context.addIssue({ code: "custom", path: ["canExportOmop"], message: "OMOP export also requires export permission" })
  }
})

export const researchGrantPatchSchema = z.object({
  canQuery: z.boolean().optional(),
  canInspectCases: z.boolean().optional(),
  canExport: z.boolean().optional(),
  canExportOmop: z.boolean().optional(),
  canShareCohorts: z.boolean().optional(),
  expiresAt: z.string().datetime().optional(),
  revoked: z.literal(true).optional(),
}).strict()
