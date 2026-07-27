import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { PassThrough, Transform, type Writable } from "node:stream"
import { finished } from "node:stream/promises"
import { ZipArchive } from "archiver"
import type {
  ResearchCohortDefinition,
  ResearchExportFormat,
  ResearchExportRecord,
} from "@lospor/core/research"
import { normalizeResearchCohort } from "@lospor/core/research"
import { deriveQualityStatus } from "@lospor/core/omop"
import type { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import {
  mapCasesToOmop,
  type ExportQualityWarning,
  type OmopBundle,
} from "@/lib/omop-mapper"
import { CASE_SELECT, redactExportRow } from "@/lib/omop-export-source"
import type { AuthUser } from "@/lib/mobile-auth"
import {
  researchContextForAction,
  resolveResearchContext,
  type ResearchContext,
} from "./access"
import { compileResearchWhere } from "./cohort-where"
import { researchExportStorage } from "./export-storage"
import {
  RESEARCH_SUMMARY_SELECT,
  mapResearchSummary,
} from "./mappers"

const SOURCE_VERSION = "7.2.0"
const EXPORT_PAGE_SIZE = 250
const EXPORT_LEASE_MS = 5 * 60 * 1000

type ExportRecordRow = {
  id: string
  name: string
  format: string
  status: string
  definition: Prisma.JsonValue
  rowCount: number | null
  definitionHash: string | null
  snapshotHash: string | null
  snapshotCaseCount: number | null
  asOf: Date | null
  sourceCommit: string | null
  snapshotRevisions: Prisma.JsonValue | null
  checksum: string | null
  error: string | null
  artifactFilename: string | null
  artifactContentType: string | null
  artifactByteSize: bigint | null
  sourceVersion: string | null
  generatedAt: Date | null
  legacy: boolean
  createdAt: Date
  completedAt: Date | null
}

type SnapshotRevision = { id: string; updatedAt: Date }
type StoredSnapshotRevision = { id: string; updatedAt: string }
type SnapshotPage = { revisions: SnapshotRevision[]; rowIdStart: number }

export class ResearchExportError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class ResearchExportQualityError extends ResearchExportError {
  constructor(readonly warnings: ExportQualityWarning[]) {
    super("RESEARCH_EXPORT_QUALITY_FAILED", 422, "Export blocked by the OMOP quality gate")
  }
}

function mapExportRecord(record: ExportRecordRow): ResearchExportRecord {
  return {
    id: record.id,
    name: record.name,
    format: record.format as ResearchExportFormat,
    status: record.status as ResearchExportRecord["status"],
    definition: record.definition as unknown as ResearchCohortDefinition,
    rowCount: record.rowCount,
    checksum: record.checksum,
    error: record.error,
    filename: record.artifactFilename,
    asOf: record.asOf?.toISOString() ?? null,
    definitionHash: record.definitionHash,
    snapshotHash: record.snapshotHash,
    matchingCases: record.snapshotCaseCount,
    sourceCommit: record.sourceCommit,
    contentType: record.artifactContentType,
    byteSize: record.artifactByteSize == null ? null : Number(record.artifactByteSize),
    sourceVersion: record.sourceVersion,
    generatedAt: record.generatedAt?.toISOString() ?? null,
    legacy: record.legacy,
    createdAt: record.createdAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
  }
}

function hashDefinition(definition: ResearchCohortDefinition): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex")
}


function hashSnapshot(revisions: SnapshotRevision[]): string {
  const hash = createHash("sha256")
  for (const revision of revisions) {
    hash.update(revision.id)
    hash.update("\0")
    hash.update(revision.updatedAt.toISOString())
    hash.update("\n")
  }
  return hash.digest("hex")
}

function storedSnapshot(revisions: SnapshotRevision[]): StoredSnapshotRevision[] {
  return revisions.map(revision => ({
    id: revision.id,
    updatedAt: revision.updatedAt.toISOString(),
  }))
}

function parseSnapshot(record: ClaimedExport): SnapshotRevision[] {
  if (!Array.isArray(record.snapshotRevisions)) {
    throw new ResearchExportError("RESEARCH_EXPORT_SNAPSHOT_MISSING", 409, "Export revision manifest is missing")
  }
  const revisions = record.snapshotRevisions.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ResearchExportError("RESEARCH_EXPORT_SNAPSHOT_INVALID", 409, "Export revision manifest is invalid")
    }
    const id = "id" in item ? item.id : null
    const updatedAt = "updatedAt" in item ? item.updatedAt : null
    const parsed = typeof updatedAt === "string" ? new Date(updatedAt) : new Date(Number.NaN)
    if (typeof id !== "string" || !id || !Number.isFinite(parsed.getTime())) {
      throw new ResearchExportError("RESEARCH_EXPORT_SNAPSHOT_INVALID", 409, "Export revision manifest is invalid")
    }
    return { id, updatedAt: parsed }
  })
  if (record.snapshotCaseCount !== revisions.length || record.snapshotHash !== hashSnapshot(revisions)) {
    throw new ResearchExportError("RESEARCH_EXPORT_SNAPSHOT_MISMATCH", 409, "Export revision manifest integrity check failed")
  }
  return revisions
}

function exportAction(format: ResearchExportFormat) {
  return format === "omop-csv" || format === "omop-json" ? "exportOmop" : "export"
}

function fileSpec(name: string, format: ResearchExportFormat, asOf: Date) {
  const stem = name.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "research"
  const date = asOf.toISOString().slice(0, 10)
  if (format === "csv") {
    return { filename: `lospor_${stem}_${date}.csv`, contentType: "text/csv; charset=utf-8" }
  }
  if (format === "json") {
    return { filename: `lospor_${stem}_${date}.json`, contentType: "application/json; charset=utf-8" }
  }
  if (format === "omop-csv") {
    return { filename: `lospor_${stem}_omop_${date}.zip`, contentType: "application/zip" }
  }
  return { filename: `lospor_${stem}_omop_${date}.json`, contentType: "application/json; charset=utf-8" }
}

function scopedContext(context: ResearchContext, format: ResearchExportFormat): ResearchContext {
  const action = exportAction(format)
  if (!context.permissions.export || (action === "exportOmop" && !context.permissions.exportOmop)) {
    throw new ResearchExportError(
      action === "exportOmop" ? "OMOP_EXPORT_FORBIDDEN" : "RESEARCH_EXPORT_FORBIDDEN",
      403,
      action === "exportOmop" ? "OMOP export permission is required" : "Research export permission is required",
    )
  }
  return researchContextForAction(context, action)
}

function scopeStillAllowed(context: ResearchContext, institutionIds: string[]): boolean {
  return context.activeScope.allInstitutions || institutionIds.every(id => context.institutionIds.includes(id))
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
  const actionContext = scopedContext(context, input.format)
  const definition = normalizeResearchCohort(input.definition)
  const scopeInstitutionIds = [...actionContext.institutionIds].sort()
  const cohortWhere = await compileResearchWhere(definition, actionContext)

  return prisma.$transaction(async transaction => {
    const asOf = new Date()
    const where: Prisma.CaseWhereInput = {
      AND: [
        cohortWhere,
        { institutionId: { in: scopeInstitutionIds } },
        { updatedAt: { lte: asOf } },
      ],
    }
    const revisions = await readSnapshotRevisions(where, transaction)
    const spec = fileSpec(input.name, input.format, asOf)
    const record = await transaction.researchExport.create({
      data: {
        ownerId: context.user.id,
        institutionId: scopeInstitutionIds.length === 1 ? scopeInstitutionIds[0] : null,
        name: input.name,
        format: input.format,
        definition: definition as unknown as Prisma.InputJsonValue,
        definitionHash: hashDefinition(definition),
        snapshotRevisions: storedSnapshot(revisions) as unknown as Prisma.InputJsonValue,
        snapshotHash: hashSnapshot(revisions),
        snapshotCaseCount: revisions.length,
        scopeInstitutionIds,
        asOf,
        sourceVersion: SOURCE_VERSION,
        sourceCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "untracked",
        artifactFilename: spec.filename,
        artifactContentType: spec.contentType,
        legacy: false,
      },
    })
    return mapExportRecord(record)
  }, {
    isolationLevel: "RepeatableRead",
    maxWait: 10_000,
    timeout: 120_000,
  })
}

async function claimResearchExport(exportId?: string) {
  const now = new Date()
  const candidate = exportId
    ? await prisma.researchExport.findUnique({ where: { id: exportId } })
    : await prisma.researchExport.findFirst({
        where: {
          OR: [
            { status: "PENDING" },
            { status: "RUNNING", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
          ],
        },
        orderBy: { createdAt: "asc" },
      })
  if (!candidate || candidate.legacy || candidate.status === "COMPLETE" || candidate.status === "FAILED") {
    return null
  }

  const leaseOwner = randomUUID()
  const result = await prisma.researchExport.updateMany({
    where: {
      id: candidate.id,
      OR: [
        { status: "PENDING" },
        { status: "RUNNING", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      ],
    },
    data: {
      status: "RUNNING",
      startedAt: candidate.startedAt ?? now,
      generatedAt: candidate.generatedAt ?? now,
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + EXPORT_LEASE_MS),
      attemptCount: { increment: 1 },
      error: null,
    },
  })
  if (result.count !== 1) return null
  return prisma.researchExport.findFirst({
    where: { id: candidate.id, status: "RUNNING", leaseOwner },
    include: { owner: { include: { institution: { select: { name: true } } } } },
  })
}

type ClaimedExport = NonNullable<Awaited<ReturnType<typeof claimResearchExport>>>

async function renewLease(record: ClaimedExport): Promise<void> {
  const renewed = await prisma.researchExport.updateMany({
    where: { id: record.id, status: "RUNNING", leaseOwner: record.leaseOwner },
    data: { leaseExpiresAt: new Date(Date.now() + EXPORT_LEASE_MS) },
  })
  if (renewed.count !== 1) {
    throw new ResearchExportError("RESEARCH_EXPORT_LEASE_LOST", 409, "Export worker lease was lost")
  }
}

function workerUser(record: ClaimedExport): AuthUser {
  return {
    id: record.owner.id,
    role: record.owner.role,
    institutionId: record.owner.institutionId,
    institutionName: record.owner.institution?.name ?? null,
    firstName: record.owner.firstName || null,
    lastName: record.owner.lastName || null,
    title: record.owner.title || null,
    jti: null,
  }
}

async function workerContext(record: ClaimedExport): Promise<ResearchContext> {
  if (record.owner.deletedAt) {
    throw new ResearchExportError("RESEARCH_EXPORT_OWNER_INACTIVE", 403, "Export owner is inactive")
  }
  const resolved = await resolveResearchContext(workerUser(record))
  if (!resolved) {
    throw new ResearchExportError("RESEARCH_EXPORT_ACCESS_REVOKED", 403, "Research access was revoked")
  }
  const context = scopedContext(resolved, record.format as ResearchExportFormat)
  if (!scopeStillAllowed(context, record.scopeInstitutionIds)) {
    throw new ResearchExportError(
      "RESEARCH_EXPORT_SCOPE_REVOKED",
      403,
      "One or more institutions are no longer available for this export",
    )
  }
  return context
}

function snapshotManifest(record: ClaimedExport) {
  if (!record.asOf || !record.definitionHash) {
    throw new ResearchExportError("RESEARCH_EXPORT_LEGACY", 410, "Legacy exports must be recreated")
  }
  const definition = normalizeResearchCohort(record.definition as unknown as ResearchCohortDefinition)
  if (hashDefinition(definition) !== record.definitionHash) {
    throw new ResearchExportError("RESEARCH_EXPORT_DEFINITION_MISMATCH", 409, "Export definition integrity check failed")
  }
  return { definition, revisions: parseSnapshot(record) }
}

type SnapshotReader = Pick<Prisma.TransactionClient, "case">

async function readSnapshotRevisions(
  where: Prisma.CaseWhereInput,
  client: SnapshotReader = prisma,
): Promise<SnapshotRevision[]> {
  const revisions: SnapshotRevision[] = []
  let cursor: string | undefined
  while (true) {
    const page = await client.case.findMany({
      where,
      select: { id: true, updatedAt: true },
      orderBy: { id: "asc" },
      take: 1000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (!page.length) break
    revisions.push(...page)
    cursor = page.at(-1)?.id
  }
  return revisions
}

function revisionWhere(revisions: SnapshotRevision[]): Prisma.CaseWhereInput {
  return {
    OR: revisions.map(revision => ({ id: revision.id, updatedAt: revision.updatedAt })),
  }
}

function orderRevisionRows<T extends { id: string }>(revisions: SnapshotRevision[], rows: T[]): T[] {
  const byId = new Map(rows.map(row => [row.id, row]))
  const ordered = revisions.map(revision => byId.get(revision.id)).filter((row): row is T => Boolean(row))
  if (ordered.length !== revisions.length) {
    throw new ResearchExportError(
      "RESEARCH_EXPORT_SNAPSHOT_CHANGED",
      409,
      "A case changed while the export snapshot was being generated; create a new export",
    )
  }
  return ordered
}

async function fetchSummaryPage(revisions: SnapshotRevision[]) {
  const rows = await prisma.case.findMany({
    where: revisionWhere(revisions),
    select: RESEARCH_SUMMARY_SELECT,
  })
  return orderRevisionRows(revisions, rows).map(mapResearchSummary)
}

async function fetchOmopPage(revisions: SnapshotRevision[]) {
  const rows = await prisma.case.findMany({
    where: revisionWhere(revisions),
    select: CASE_SELECT,
  })
  return orderRevisionRows(revisions, rows).map(redactExportRow)
}

async function writeChunk(stream: Writable, chunk: string | Buffer): Promise<void> {
  if (!stream.write(chunk)) await once(stream, "drain")
}

function csvEscape(value: unknown): string {
  if (value == null) return ""
  const text = Array.isArray(value) ? value.join(" | ") : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const SUMMARY_COLUMNS = [
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

async function writeSummaryArtifact(
  output: Writable,
  format: "csv" | "json",
  record: ClaimedExport,
  revisions: SnapshotRevision[],
): Promise<void> {
  if (format === "csv") {
    await writeChunk(output, `${SUMMARY_COLUMNS.join(",")}\n`)
  } else {
    const metadata = {
      exportId: record.id,
      source: "LOSPOR",
      sourceVersion: record.sourceVersion,
      sourceCommit: record.sourceCommit,
      generatedAt: record.generatedAt?.toISOString(),
      asOf: record.asOf?.toISOString(),
      definitionHash: record.definitionHash,
      snapshotHash: record.snapshotHash,
      matchingCases: revisions.length,
      exportedCases: revisions.length,
      complete: true,
      rowShape: "pseudonymous-research-summary-v1",
    }
    await writeChunk(output, `{"metadata":${JSON.stringify(metadata)},"cases":[`)
  }

  let first = true
  for (let offset = 0; offset < revisions.length; offset += EXPORT_PAGE_SIZE) {
    const rows = await fetchSummaryPage(revisions.slice(offset, offset + EXPORT_PAGE_SIZE))
    for (const row of rows) {
      if (format === "csv") {
        await writeChunk(output, `${SUMMARY_COLUMNS.map(column => csvEscape(row[column])).join(",")}\n`)
      } else {
        await writeChunk(output, `${first ? "" : ","}${JSON.stringify(row)}`)
        first = false
      }
    }
    await renewLease(record)
  }
  if (format === "json") await writeChunk(output, "]}")
}

async function writeArtifact(
  key: string,
  contentType: string,
  build: (output: Writable) => Promise<void>,
): Promise<{ checksum: string; byteSize: number }> {
  const sink = await researchExportStorage().create(key, contentType)
  const hash = createHash("sha256")
  let byteSize = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      hash.update(bytes)
      byteSize += bytes.length
      callback(null, bytes)
    },
  })
  meter.pipe(sink.writable)
  const meterDone = finished(meter)
  meterDone.catch(() => undefined)
  sink.done.catch(() => undefined)
  try {
    await build(meter)
    if (!meter.writableEnded) meter.end()
    await Promise.all([meterDone, sink.done])
    return { checksum: hash.digest("hex"), byteSize }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("Export stream failed")
    meter.destroy(failure)
    sink.writable.destroy()
    await Promise.all([
      meterDone.catch(() => undefined),
      sink.done.catch(() => undefined),
    ])
    throw error
  }
}

type OmopTableName = Exclude<keyof OmopBundle, "metadata">

const OMOP_TABLES: OmopTableName[] = [
  "person",
  "observation_period",
  "visit_occurrence",
  "condition_occurrence",
  "drug_exposure",
  "measurement",
  "procedure_occurrence",
  "observation",
]

const OMOP_COLUMNS: Record<OmopTableName, readonly string[]> = {
  person: [
    "person_id", "gender_concept_id", "year_of_birth", "month_of_birth", "day_of_birth",
    "birth_datetime", "race_concept_id", "ethnicity_concept_id", "person_source_value",
    "gender_source_value",
  ],
  observation_period: [
    "observation_period_id", "person_id", "observation_period_start_date",
    "observation_period_end_date", "period_type_concept_id",
  ],
  visit_occurrence: [
    "visit_occurrence_id", "person_id", "visit_concept_id", "visit_start_date", "visit_end_date",
    "visit_type_concept_id", "visit_source_value", "care_site_source_value",
  ],
  condition_occurrence: [
    "condition_occurrence_id", "person_id", "condition_concept_id", "condition_start_date",
    "condition_type_concept_id", "condition_source_value", "visit_occurrence_id",
  ],
  drug_exposure: [
    "drug_exposure_id", "person_id", "drug_concept_id", "drug_exposure_start_date",
    "drug_type_concept_id", "drug_source_value", "drug_source_concept_id", "dose_value",
    "dose_unit_source_value", "route_source_value", "visit_occurrence_id",
  ],
  measurement: [
    "measurement_id", "person_id", "measurement_concept_id", "measurement_date",
    "measurement_datetime", "measurement_type_concept_id", "value_as_number", "unit_concept_id",
    "unit_source_value", "measurement_source_value", "visit_occurrence_id",
  ],
  procedure_occurrence: [
    "procedure_occurrence_id", "person_id", "procedure_concept_id", "procedure_date",
    "procedure_type_concept_id", "procedure_source_value", "visit_occurrence_id",
  ],
  observation: [
    "observation_id", "person_id", "observation_concept_id", "observation_date",
    "observation_type_concept_id", "value_as_string", "observation_source_value",
    "visit_occurrence_id",
  ],
}

function omopExportContext(
  record: ClaimedExport,
  definition: ResearchCohortDefinition,
  matchingCases: number,
  rowIdStart: number,
) {
  return {
    userId: record.ownerId,
    userRole: record.owner.role,
    statusFilter: definition.filters.statuses ?? [],
    excludedCaseCount: 0,
    matchingCaseCount: matchingCases,
    complete: true,
    gitCommit: record.sourceCommit ?? "untracked",
    forcedOverride: false,
    exportId: record.id,
    generatedAt: record.generatedAt?.toISOString(),
    rowIdStart,
  }
}

function sequentialOmopRows(bundle: OmopBundle): number {
  return bundle.condition_occurrence.length
    + bundle.drug_exposure.length
    + bundle.measurement.length
    + bundle.procedure_occurrence.length
    + bundle.observation.length
}

function mergeQualityWarning(
  warnings: Map<string, ExportQualityWarning>,
  warning: ExportQualityWarning,
) {
  const key = `${warning.code}|${warning.severity}|${warning.message}`
  const existing = warnings.get(key)
  if (!existing) {
    warnings.set(key, { ...warning })
    return
  }
  if (existing.count !== undefined || warning.count !== undefined) {
    existing.count = (existing.count ?? 0) + (warning.count ?? 0)
  }
}


function earliest(current: string | null, next: string): string {
  if (current === null) return next
  return next < current ? next : current
}

function latest(current: string | null, next: string): string {
  if (current === null) return next
  return next > current ? next : current
}
async function prepareOmopExport(
  record: ClaimedExport,
  definition: ResearchCohortDefinition,
  revisions: SnapshotRevision[],
): Promise<{ pages: SnapshotPage[]; metadata: OmopBundle["metadata"] }> {
  const pages: SnapshotPage[] = []
  const warnings = new Map<string, ExportQualityWarning>()
  const tableCounts: OmopBundle["metadata"]["table_counts"] = {
    person: 0,
    observation_period: 0,
    visit_occurrence: 0,
    condition_occurrence: 0,
    drug_exposure: 0,
    measurement: 0,
    procedure_occurrence: 0,
    observation: 0,
  }
  const mappingSummary = { mapped_rows: 0, source_only_rows: 0, unmapped_rows: 0 }
  let baseMetadata: OmopBundle["metadata"] | null = null
  let rowIdStart = 1
  let rangeFrom: string | null = null
  let rangeTo: string | null = null

  for (let offset = 0; offset < revisions.length; offset += EXPORT_PAGE_SIZE) {
    const pageRevisions = revisions.slice(offset, offset + EXPORT_PAGE_SIZE)
    const cases = await fetchOmopPage(pageRevisions)
    const bundle = mapCasesToOmop(
      cases,
      omopExportContext(record, definition, revisions.length, rowIdStart),
    )
    baseMetadata ??= bundle.metadata
    pages.push({ revisions: pageRevisions, rowIdStart })
    rowIdStart += sequentialOmopRows(bundle)
    for (const table of OMOP_TABLES) tableCounts[table] += bundle[table].length
    mappingSummary.mapped_rows += bundle.metadata.mapping_summary.mapped_rows
    mappingSummary.source_only_rows += bundle.metadata.mapping_summary.source_only_rows
    mappingSummary.unmapped_rows += bundle.metadata.mapping_summary.unmapped_rows
    for (const warning of bundle.metadata.quality_warnings) mergeQualityWarning(warnings, warning)
    if (bundle.metadata.date_range) {
      rangeFrom = earliest(rangeFrom, bundle.metadata.date_range.from)
      rangeTo = latest(rangeTo, bundle.metadata.date_range.to)
    }
    await renewLease(record)
  }

  if (!baseMetadata) {
    const empty = mapCasesToOmop([], omopExportContext(record, definition, 0, 1))
    baseMetadata = empty.metadata
    for (const warning of empty.metadata.quality_warnings) mergeQualityWarning(warnings, warning)
  }
  const qualityWarnings = [...warnings.values()]
  const metadata: OmopBundle["metadata"] = {
    ...baseMetadata,
    export_id: record.id,
    generated_at: record.generatedAt?.toISOString() ?? baseMetadata.generated_at,
    date_range: rangeFrom && rangeTo ? { from: rangeFrom, to: rangeTo } : null,
    matching_case_count: revisions.length,
    exported_case_count: revisions.length,
    complete: true,
    included_case_count: revisions.length,
    excluded_case_count: 0,
    case_count: revisions.length,
    mapping_summary: mappingSummary,
    table_counts: tableCounts,
    quality_warnings: qualityWarnings,
    data_quality_status: deriveQualityStatus(qualityWarnings),
  }
  if (metadata.data_quality_status === "FAIL") {
    throw new ResearchExportQualityError(
      qualityWarnings.filter(warning => warning.severity === "error"),
    )
  }
  return { pages, metadata }
}

async function eachOmopTableRow(
  record: ClaimedExport,
  definition: ResearchCohortDefinition,
  matchingCases: number,
  pages: SnapshotPage[],
  table: OmopTableName,
  visit: (row: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  for (const page of pages) {
    const cases = await fetchOmopPage(page.revisions)
    const bundle = mapCasesToOmop(
      cases,
      omopExportContext(record, definition, matchingCases, page.rowIdStart),
    )
    for (const row of bundle[table] as unknown as Record<string, unknown>[]) await visit(row)
    await renewLease(record)
  }
}

async function writeOmopZip(
  output: Writable,
  record: ClaimedExport,
  definition: ResearchCohortDefinition,
  revisions: SnapshotRevision[],
  pages: SnapshotPage[],
  metadata: OmopBundle["metadata"],
): Promise<void> {
  const archive = new ZipArchive({ zlib: { level: 6 } })
  const archiveFailure = new Promise<never>((_resolve, reject) => {
    archive.on("warning", (error: Error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") reject(error)
    })
    archive.on("error", reject)
  })

  archive.pipe(output)
  archive.append(JSON.stringify({
    ...metadata,
    definition_hash: record.definitionHash,
    as_of: record.asOf?.toISOString(),
    snapshot_hash: record.snapshotHash,
  }, null, 2), { name: "manifest.json" })

  for (const table of OMOP_TABLES) {
    const entry = new PassThrough()
    archive.append(entry, { name: `${table}.csv` })
    const columns = OMOP_COLUMNS[table]
    await writeChunk(entry, `${columns.join(",")}\n`)
    await eachOmopTableRow(record, definition, revisions.length, pages, table, async row => {
      await writeChunk(entry, `${columns.map(column => csvEscape(row[column])).join(",")}\n`)
    })
    entry.end()
  }
  await Promise.race([archive.finalize(), archiveFailure])
}

async function writeOmopJson(
  output: Writable,
  record: ClaimedExport,
  definition: ResearchCohortDefinition,
  revisions: SnapshotRevision[],
  pages: SnapshotPage[],
  metadata: OmopBundle["metadata"],
): Promise<void> {
  await writeChunk(output, `{"metadata":${JSON.stringify({
    ...metadata,
    definition_hash: record.definitionHash,
    as_of: record.asOf?.toISOString(),
    snapshot_hash: record.snapshotHash,
  })}`)
  for (const table of OMOP_TABLES) {
    await writeChunk(output, `,"${table}":[`)
    let first = true
    await eachOmopTableRow(record, definition, revisions.length, pages, table, async row => {
      await writeChunk(output, `${first ? "" : ","}${JSON.stringify(row)}`)
      first = false
    })
    await writeChunk(output, "]")
  }
  await writeChunk(output, "}")
}

function failureMessage(error: unknown): string {
  if (error instanceof ResearchExportQualityError) {
    return JSON.stringify({ message: error.message, warnings: error.warnings }).slice(0, 2000)
  }
  return (error instanceof Error ? error.message : "Export failed").slice(0, 2000)
}

export async function processResearchExport(exportId?: string): Promise<ResearchExportRecord | null> {
  const record = await claimResearchExport(exportId)
  if (!record) return null
  if (!record.leaseOwner || !record.artifactFilename || !record.artifactContentType) {
    throw new ResearchExportError("RESEARCH_EXPORT_INVALID", 409, "Export record is incomplete")
  }

  let artifactKey: string | null = null
  try {
    await workerContext(record)
    const snapshot = snapshotManifest(record)
    const revisions = snapshot.revisions
    await renewLease(record)

    artifactKey = `${record.id}/${record.leaseOwner}/${record.artifactFilename}`
    const format = record.format as ResearchExportFormat
    let artifact: { checksum: string; byteSize: number }

    if (format === "csv" || format === "json") {
      artifact = await writeArtifact(artifactKey, record.artifactContentType, output =>
        writeSummaryArtifact(output, format, record, revisions))
    } else {
      const omop = await prepareOmopExport(record, snapshot.definition, revisions)
      artifact = await writeArtifact(artifactKey, record.artifactContentType, output =>
        format === "omop-csv"
          ? writeOmopZip(output, record, snapshot.definition, revisions, omop.pages, omop.metadata)
          : writeOmopJson(output, record, snapshot.definition, revisions, omop.pages, omop.metadata))
    }

    const completedAt = new Date()
    const completed = await prisma.researchExport.updateMany({
      where: { id: record.id, status: "RUNNING", leaseOwner: record.leaseOwner },
      data: {
        status: "COMPLETE",
        rowCount: revisions.length,
        checksum: artifact.checksum,
        artifactKey,
        artifactByteSize: BigInt(artifact.byteSize),
        completedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        error: null,
      },
    })
    if (completed.count !== 1) {
      throw new ResearchExportError("RESEARCH_EXPORT_LEASE_LOST", 409, "Export worker lease was lost")
    }
    const stored = await prisma.researchExport.findUnique({ where: { id: record.id } })
    return stored ? mapExportRecord(stored) : null
  } catch (error) {
    if (artifactKey) await researchExportStorage().remove(artifactKey).catch(() => undefined)
    await prisma.researchExport.updateMany({
      where: { id: record.id, status: "RUNNING", leaseOwner: record.leaseOwner },
      data: {
        status: "FAILED",
        error: failureMessage(error),
        completedAt: new Date(),
        artifactKey: null,
        artifactByteSize: null,
        checksum: null,
        rowCount: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    }).catch(() => undefined)
    throw error
  }
}

async function ownedExport(context: ResearchContext, exportId: string) {
  const record = await prisma.researchExport.findFirst({
    where: { id: exportId, ownerId: context.user.id },
  })
  if (!record) {
    throw new ResearchExportError("EXPORT_NOT_FOUND", 404, "Export not found")
  }
  const actionContext = scopedContext(context, record.format as ResearchExportFormat)
  if (!scopeStillAllowed(actionContext, record.scopeInstitutionIds)) {
    throw new ResearchExportError("RESEARCH_EXPORT_SCOPE_REVOKED", 403, "Export scope is no longer permitted")
  }
  return record
}

export async function getResearchExport(context: ResearchContext, exportId: string) {
  return mapExportRecord(await ownedExport(context, exportId))
}

export async function openResearchExport(context: ResearchContext, exportId: string) {
  const record = await ownedExport(context, exportId)
  if (record.legacy || !record.artifactKey) {
    throw new ResearchExportError(
      "RESEARCH_EXPORT_LEGACY",
      410,
      "This export predates immutable artifacts and must be recreated",
    )
  }
  if (record.status === "PENDING" || record.status === "RUNNING") {
    throw new ResearchExportError("RESEARCH_EXPORT_NOT_READY", 409, "Export is still being generated")
  }
  if (record.status === "FAILED") {
    throw new ResearchExportError("RESEARCH_EXPORT_FAILED", 422, record.error ?? "Export failed")
  }
  if (!record.artifactFilename || !record.artifactContentType || !record.checksum) {
    throw new ResearchExportError("RESEARCH_EXPORT_ARTIFACT_INVALID", 503, "Export artifact metadata is incomplete")
  }

  let artifact
  try {
    artifact = await researchExportStorage().open(record.artifactKey)
  } catch {
    throw new ResearchExportError("RESEARCH_EXPORT_ARTIFACT_MISSING", 503, "Export artifact is unavailable")
  }
  const expectedLength = record.artifactByteSize == null ? null : Number(record.artifactByteSize)
  if (
    expectedLength !== null
    && artifact.contentLength !== null
    && artifact.contentLength !== expectedLength
  ) {
    throw new ResearchExportError("RESEARCH_EXPORT_ARTIFACT_MISMATCH", 503, "Export artifact size check failed")
  }
  return {
    stream: artifact.stream,
    contentLength: expectedLength ?? artifact.contentLength,
    filename: record.artifactFilename,
    contentType: record.artifactContentType,
    record: mapExportRecord(record),
  }
}
