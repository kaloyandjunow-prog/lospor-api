import { createHash } from "node:crypto"
import type {
  ResearchCohortDefinition,
  ResearchExportFormat,
  ResearchExportRecord,
} from "@lospor/core/research"
import type { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { mapCasesToOmop } from "@/lib/omop-mapper"
import {
  CASE_SELECT,
  bundleToCsv,
  redactExportRow,
} from "@/app/v1/export/omop/route"
import type { ResearchContext } from "./access"
import { compileResearchWhere } from "./cohort-where"
import { readAllResearchSummaries } from "./repository"

function mapExportRecord(record: {
  id: string
  name: string
  format: string
  status: string
  definition: Prisma.JsonValue
  rowCount: number | null
  checksum: string | null
  error: string | null
  createdAt: Date
  completedAt: Date | null
}): ResearchExportRecord {
  return {
    id: record.id,
    name: record.name,
    format: record.format as ResearchExportFormat,
    status: record.status as ResearchExportRecord["status"],
    definition: record.definition as unknown as ResearchCohortDefinition,
    rowCount: record.rowCount,
    checksum: record.checksum,
    error: record.error,
    createdAt: record.createdAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
  }
}

export async function listResearchExports(context: ResearchContext) {
  const records = await prisma.researchExport.findMany({
    where: { ownerId: context.user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  })
  return records.map(mapExportRecord)
}

export async function createResearchExport(
  context: ResearchContext,
  input: {
    name: string
    format: ResearchExportFormat
    definition: ResearchCohortDefinition
  },
) {
  const record = await prisma.researchExport.create({
    data: {
      ownerId: context.user.id,
      institutionId: context.institutionIds.length === 1
        ? context.institutionIds[0]
        : null,
      name: input.name,
      format: input.format,
      definition: input.definition as unknown as Prisma.InputJsonValue,
    },
  })
  return mapExportRecord(record)
}

function csvEscape(value: unknown): string {
  if (value == null) return ""
  const text = Array.isArray(value) ? value.join(" | ") : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function summariesToCsv(rows: Awaited<ReturnType<typeof readAllResearchSummaries>>): string {
  const columns = [
    "researchId",
    "status",
    "period",
    "ageYears",
    "sex",
    "asa",
    "diagnosis",
    "diagnosisCode",
    "diagnosisLabelEn",
    "diagnosisLabelBg",
    "procedure",
    "procedureCode",
    "procedureLabelEn",
    "procedureLabelBg",
    "durationMinutes",
    "technique",
    "disposition",
    "complications",
    "completeness",
  ] as const
  return [
    columns.join(","),
    ...rows.map(row => columns.map(column => csvEscape(row[column])).join(",")),
  ].join("\n")
}

export class ResearchExportQualityError extends Error {
  constructor(readonly warnings: unknown[]) {
    super("Export blocked by the OMOP quality gate")
  }
}

export async function generateResearchExport(
  context: ResearchContext,
  exportId: string,
): Promise<{
  body: string
  contentType: string
  filename: string
  record: ResearchExportRecord
}> {
  const record = await prisma.researchExport.findFirst({
    where: { id: exportId, ownerId: context.user.id },
  })
  if (!record) throw new Error("EXPORT_NOT_FOUND")
  const format = record.format as ResearchExportFormat
  if ((format === "omop-csv" || format === "omop-json") && !context.permissions.exportOmop) {
    throw new Error("OMOP_EXPORT_FORBIDDEN")
  }

  await prisma.researchExport.update({
    where: { id: record.id },
    data: { status: "RUNNING", startedAt: new Date(), error: null },
  })

  try {
    const definition = record.definition as unknown as ResearchCohortDefinition
    const where = await compileResearchWhere(definition, context)
    const count = await prisma.case.count({ where })
    let body: string
    let contentType: string
    let extension: string

    if (format === "csv" || format === "json") {
      const rows = await readAllResearchSummaries(where)
      body = format === "csv"
        ? summariesToCsv(rows)
        : JSON.stringify({
            metadata: {
              source: "LOSPOR",
              generatedAt: new Date().toISOString(),
              matchingCases: count,
              exportedCases: rows.length,
              complete: rows.length === count,
            },
            cases: rows,
          }, null, 2)
      contentType = format === "csv"
        ? "text/csv; charset=utf-8"
        : "application/json; charset=utf-8"
      extension = format
    } else {
      const cases = await prisma.case.findMany({
        where,
        select: CASE_SELECT,
        orderBy: { createdAt: "asc" },
      })
      const bundle = mapCasesToOmop(cases.map(redactExportRow), {
        userId: context.user.id,
        userRole: context.user.role,
        statusFilter: definition.filters.statuses ?? ["COMPLETE"],
        excludedCaseCount: 0,
        matchingCaseCount: count,
        complete: cases.length === count,
        gitCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "untracked",
        forcedOverride: false,
      })
      if (bundle.metadata.data_quality_status === "FAIL") {
        throw new ResearchExportQualityError(
          bundle.metadata.quality_warnings.filter(warning => warning.severity === "error"),
        )
      }
      body = format === "omop-csv" ? bundleToCsv(bundle) : JSON.stringify(bundle, null, 2)
      contentType = format === "omop-csv"
        ? "text/csv; charset=utf-8"
        : "application/json; charset=utf-8"
      extension = format === "omop-csv" ? "csv" : "json"
    }

    const checksum = createHash("sha256").update(body).digest("hex")
    const completed = await prisma.researchExport.update({
      where: { id: record.id },
      data: {
        status: "COMPLETE",
        rowCount: count,
        checksum,
        completedAt: new Date(),
      },
    })
    return {
      body,
      contentType,
      filename: `lospor_${record.name.replace(/[^a-z0-9_-]+/gi, "_")}_${new Date().toISOString().slice(0, 10)}.${extension}`,
      record: mapExportRecord(completed),
    }
  } catch (error) {
    await prisma.researchExport.update({
      where: { id: record.id },
      data: {
        status: "FAILED",
        error: error instanceof Error ? error.message.slice(0, 500) : "Export failed",
        completedAt: new Date(),
      },
    })
    throw error
  }
}
