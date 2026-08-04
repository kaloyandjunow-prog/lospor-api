import { NextRequest, NextResponse } from "next/server"
import { csvCell } from "@/lib/csv-cell"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { CaseStatus, type Prisma } from "@/generated/prisma/client"
import { mapCasesToOmop } from "@/lib/omop-mapper"
import { CASE_SELECT, redactExportRow } from "@/lib/omop-export-source"

const VALID_STATUSES = new Set<string>(Object.values(CaseStatus))
const EXPORT_CASE_LIMIT = 5000

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!requireRole(user, ["ADMIN"])) return NextResponse.json({ error: "Admin access required" }, { status: 403 })

  const caseId    = req.nextUrl.searchParams.get("caseId")
  const format    = req.nextUrl.searchParams.get("format") ?? "json"   // "json" | "csv"
  const rawStatus = req.nextUrl.searchParams.get("status")             // comma-separated status override
  const force     = req.nextUrl.searchParams.get("force") === "true"   // admin override for FAIL gate

  const allowedStatuses: CaseStatus[] = rawStatus
    ? rawStatus.split(",").map(s => s.trim().toUpperCase()).filter(s => VALID_STATUSES.has(s)) as CaseStatus[]
    : [CaseStatus.COMPLETE]

  const where: Prisma.CaseWhereInput = caseId
    ? { id: caseId }
    : { status: { in: allowedStatuses } }

  const [matchingCount, excludedCount] = await Promise.all([
    prisma.case.count({ where }),
    caseId ? Promise.resolve(0) : prisma.case.count({
      where: { status: { notIn: allowedStatuses } },
    }),
  ])

  if (caseId && matchingCount === 0) {
    return NextResponse.json({ error: "Case not found" }, { status: 404 })
  }
  if (matchingCount > EXPORT_CASE_LIMIT) {
    return NextResponse.json({
      error: `Export contains ${matchingCount} matching cases; narrow the export before retrying`,
      code: "EXPORT_LIMIT_EXCEEDED",
      matchingCases: matchingCount,
      exportedCases: 0,
      exportLimit: EXPORT_CASE_LIMIT,
      complete: false,
    }, { status: 422 })
  }

  const cases = await prisma.case.findMany({
    where,
    select: CASE_SELECT,
    orderBy: { createdAt: "asc" },
    take: EXPORT_CASE_LIMIT,
  })

  const bundle = mapCasesToOmop(cases.map(redactExportRow), {
    userId:            user.id,
    userRole:          user.role ?? "unknown",
    statusFilter:      caseId ? [] : allowedStatuses,
    excludedCaseCount: excludedCount,
    matchingCaseCount: matchingCount,
    complete:           cases.length === matchingCount,
    gitCommit:         process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "untracked",
    forcedOverride:    force,
  })

  if (bundle.metadata.data_quality_status === "FAIL" && !force) {
    return NextResponse.json(
      {
        error:               "Export blocked: data quality gate FAIL",
        hint:                "Resolve the flagged issues or pass ?force=true to override as ADMIN",
        data_quality_status: "FAIL",
        quality_warnings:    bundle.metadata.quality_warnings.filter(w => w.severity === "error"),
      },
      { status: 422 },
    )
  }

  if (format === "csv") {
    const csv = bundleToCsv(bundle)
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="lospor_omop_${new Date().toISOString().substring(0,10)}.csv"`,
      },
    })
  }

  return NextResponse.json(bundle, {
    headers: {
      "Content-Disposition": `attachment; filename="lospor_omop_${new Date().toISOString().substring(0,10)}.json"`,
    },
  })
}

/** Flatten the OMOP bundle to a simple newline-delimited multi-table CSV */
export function bundleToCsv(bundle: ReturnType<typeof mapCasesToOmop>): string {
  const sections: string[] = []
  const metadataRows = [
    ["export_id",               bundle.metadata.export_id],
    ["omop_cdm_version",        bundle.metadata.omop_cdm_version],
    ["generated_at",            bundle.metadata.generated_at],
    ["generated_by_role",       bundle.metadata.generated_by_role],
    ["source",                  bundle.metadata.source],
    ["source_version",          bundle.metadata.source_version],
    ["schema_version",          bundle.metadata.schema_version],
    ["concept_map_version",     bundle.metadata.concept_map_version],
    ["data_dictionary_version", bundle.metadata.data_dictionary_version],
    ["case_status_filter",      JSON.stringify(bundle.metadata.case_status_filter)],
    ["date_range",              JSON.stringify(bundle.metadata.date_range)],
    ["matching_case_count",     String(bundle.metadata.matching_case_count)],
    ["exported_case_count",     String(bundle.metadata.exported_case_count)],
    ["complete",                String(bundle.metadata.complete)],
    ["included_case_count",     String(bundle.metadata.included_case_count)],
    ["excluded_case_count",     String(bundle.metadata.excluded_case_count)],
    ["app_git_commit",          bundle.metadata.app_git_commit],
    ["forced_override",         String(bundle.metadata.forced_override)],
    ["data_quality_status",     bundle.metadata.data_quality_status],
    ["case_count",              String(bundle.metadata.case_count)],
    ["mapping_summary",         JSON.stringify(bundle.metadata.mapping_summary)],
    ["table_counts",            JSON.stringify(bundle.metadata.table_counts)],
    ["deidentification",        JSON.stringify(bundle.metadata.deidentification)],
    ["note",                    bundle.metadata.note],
  ].map(([key, value]) => ({ key, value: value ?? "" }))
  const warningRows = bundle.metadata.quality_warnings.map(w => ({
    code: w.code,
    severity: w.severity,
    count: w.count ?? "",
    message: w.message,
  }))

  const tables: [string, Record<string, unknown>[]][] = [
    ["metadata",             metadataRows],
    ["quality_warnings",     warningRows],
    ["visit_occurrence",     bundle.visit_occurrence     as unknown as Record<string, unknown>[]],
    ["condition_occurrence", bundle.condition_occurrence as unknown as Record<string, unknown>[]],
    ["drug_exposure",        bundle.drug_exposure        as unknown as Record<string, unknown>[]],
    ["measurement",          bundle.measurement          as unknown as Record<string, unknown>[]],
    ["procedure_occurrence", bundle.procedure_occurrence as unknown as Record<string, unknown>[]],
    ["observation",          bundle.observation          as unknown as Record<string, unknown>[]],
  ]

  for (const [tableName, rows] of tables) {
    if (rows.length === 0) continue
    sections.push(`## ${tableName}`)
    const headers = Object.keys(rows[0])
    sections.push(headers.join(","))
    for (const row of rows) {
      sections.push(
        // Shared with the research export: quotes delimiters and neutralises a
        // leading formula character, so a dash-led clinical note survives being
        // opened in a spreadsheet as the text it is.
        headers.map(h => csvCell(row[h])).join(",")
      )
    }
    sections.push("")
  }

  return sections.join("\n")
}
