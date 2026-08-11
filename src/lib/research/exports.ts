import { csvCell } from "@/lib/csv-cell"
import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { Readable, Transform, type Writable } from "node:stream"
import { finished } from "node:stream/promises"
import { ZipArchive } from "archiver"
import type {
  ResearchCohortDefinition,
  ResearchExportFormat,
  ResearchExportRecord,
} from "@lospor/core/research"
import { normalizeResearchCohort } from "@lospor/core/research"
import { deriveQualityStatus } from "@lospor/core/omop"
import { Prisma } from "@/generated/prisma/client"
import { API_RELEASE_VERSION } from "@/lib/api-version"
import { prisma } from "@/lib/prisma"
import { withDirectTransaction } from "@/lib/clinical-transaction"
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

const EXPORT_PAGE_SIZE = 250
const EXPORT_LEASE_MS = 5 * 60 * 1000
const DEFAULT_EXPORT_RETENTION_DAYS = 30

function exportRetentionDays(): number {
  const configured = Number.parseInt(process.env.RESEARCH_EXPORT_RETENTION_DAYS ?? "", 10)
  if (!Number.isFinite(configured)) return DEFAULT_EXPORT_RETENTION_DAYS
  return Math.min(3650, Math.max(1, configured))
}

function artifactExpiry(completedAt: Date): Date {
  return new Date(completedAt.getTime() + exportRetentionDays() * 24 * 60 * 60 * 1000)
}

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
  revisionManifestVersion: number
  checksum: string | null
  error: string | null
  artifactKey: string | null
  artifactFilename: string | null
  artifactContentType: string | null
  artifactByteSize: bigint | null
  artifactExpiresAt: Date | null
  artifactDeletedAt: Date | null
  sourceVersion: string | null
  generatedAt: Date | null
  legacy: boolean
  createdAt: Date
  completedAt: Date | null
}

type SnapshotRevision = {
  id: string
  updatedAt: Date
  clinicalRevision: number
  eventRevision: number
  relationalRevision: number
  preopRevision: number | null
  intraopRevision: number | null
  postopRevision: number | null
}
type StoredSnapshotRevision = Omit<SnapshotRevision, "updatedAt"> & { updatedAt: string }

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

type ExportRecordResponse = ResearchExportRecord

function mapExportRecord(record: ExportRecordRow): ExportRecordResponse {
  const now = Date.now()
  const artifactAvailable = record.status === "COMPLETE" &&
    !!record.artifactKey &&
    !record.artifactDeletedAt &&
    (!record.artifactExpiresAt || record.artifactExpiresAt.getTime() > now)
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
    revisionManifestVersion: record.revisionManifestVersion,
    expiresAt: record.artifactExpiresAt?.toISOString() ?? null,
    artifactAvailable,
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
    hash.update(JSON.stringify({
      ...revision,
      updatedAt: revision.updatedAt.toISOString(),
    }))
    hash.update("\n")
  }
  return hash.digest("hex")
}

function storedSnapshot(revisions: SnapshotRevision[]): StoredSnapshotRevision[] {
  return revisions.map(revision => ({
    ...revision,
    updatedAt: revision.updatedAt.toISOString(),
  }))
}

function parseRequiredRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function parseSectionRevision(value: unknown): number | null | "invalid" {
  if (value === null) return null
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : "invalid"
}

function parseSnapshot(record: ClaimedExport): SnapshotRevision[] {
  if (record.revisionManifestVersion !== 2) {
    throw new ResearchExportError("RESEARCH_EXPORT_MANIFEST_LEGACY", 410, "Legacy export manifests must be recreated")
  }
  if (!Array.isArray(record.snapshotRevisions)) {
    throw new ResearchExportError("RESEARCH_EXPORT_SNAPSHOT_MISSING", 409, "Export revision manifest is missing")
  }
  const revisions = record.snapshotRevisions.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ResearchExportError("RESEARCH_EXPORT_SNAPSHOT_INVALID", 409, "Export revision manifest is invalid")
    }
    const id = "id" in item ? item.id : null
    const updatedAt = "updatedAt" in item ? item.updatedAt : null
    const parsedAt = typeof updatedAt === "string" ? new Date(updatedAt) : new Date(Number.NaN)
    const clinicalRevision = parseRequiredRevision("clinicalRevision" in item ? item.clinicalRevision : null)
    const eventRevision = parseRequiredRevision("eventRevision" in item ? item.eventRevision : null)
    const relationalRevision = parseRequiredRevision("relationalRevision" in item ? item.relationalRevision : null)
    const preopRevision = parseSectionRevision("preopRevision" in item ? item.preopRevision : "invalid")
    const intraopRevision = parseSectionRevision("intraopRevision" in item ? item.intraopRevision : "invalid")
    const postopRevision = parseSectionRevision("postopRevision" in item ? item.postopRevision : "invalid")
    if (
      typeof id !== "string" || !id || !Number.isFinite(parsedAt.getTime()) ||
      clinicalRevision === null || eventRevision === null || relationalRevision === null ||
      preopRevision === "invalid" || intraopRevision === "invalid" || postopRevision === "invalid"
    ) {
      throw new ResearchExportError("RESEARCH_EXPORT_SNAPSHOT_INVALID", 409, "Export revision manifest is invalid")
    }
    return {
      id,
      updatedAt: parsedAt,
      clinicalRevision,
      eventRevision,
      relationalRevision,
      preopRevision,
      intraopRevision,
      postopRevision,
    }
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
  const statuses = definition.filters.statuses ?? []
  if (statuses.length !== 1 || statuses[0] !== "COMPLETE") {
    throw new ResearchExportError(
      "RESEARCH_EXPORT_FINALIZED_ONLY",
      422,
      "Research exports require a finalized-only cohort",
    )
  }
  const scopeInstitutionIds = [...actionContext.institutionIds].sort()
  const cohortWhere = await compileResearchWhere(definition, actionContext)

  return withDirectTransaction(async transaction => {
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
        revisionManifestVersion: 2,
        scopeInstitutionIds,
        asOf,
        sourceVersion: API_RELEASE_VERSION,
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

type SnapshotReader = Pick<
  Prisma.TransactionClient,
  "case" | "preoperativeAssessment" | "intraoperativeRecord" | "postoperativeRecord"
>

async function readSnapshotRevisions(
  where: Prisma.CaseWhereInput,
  client: SnapshotReader = prisma,
): Promise<SnapshotRevision[]> {
  const revisions: SnapshotRevision[] = []
  let cursor: string | undefined
  while (true) {
    const page = await client.case.findMany({
      where,
      select: {
        id: true,
        updatedAt: true,
        clinicalRevision: true,
        eventRevision: true,
        relationalRevision: true,
      },
      orderBy: { id: "asc" },
      take: 1000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (!page.length) break

    const caseIds = page.map(row => row.id)
    const preopRows = await client.preoperativeAssessment.findMany({
      where: { caseId: { in: caseIds } },
      select: { caseId: true, syncRevision: true },
    })
    const intraopRows = await client.intraoperativeRecord.findMany({
      where: { caseId: { in: caseIds } },
      select: { caseId: true, syncRevision: true },
    })
    const postopRows = await client.postoperativeRecord.findMany({
      where: { caseId: { in: caseIds } },
      select: { caseId: true, syncRevision: true },
    })
    const preopByCase = new Map(preopRows.map(row => [row.caseId, row.syncRevision]))
    const intraopByCase = new Map(intraopRows.map(row => [row.caseId, row.syncRevision]))
    const postopByCase = new Map(postopRows.map(row => [row.caseId, row.syncRevision]))

    revisions.push(...page.map(row => ({
      id: row.id,
      updatedAt: row.updatedAt,
      clinicalRevision: row.clinicalRevision,
      eventRevision: row.eventRevision,
      relationalRevision: row.relationalRevision,
      preopRevision: preopByCase.get(row.id) ?? null,
      intraopRevision: intraopByCase.get(row.id) ?? null,
      postopRevision: postopByCase.get(row.id) ?? null,
    })))
    cursor = page.at(-1)?.id
  }
  return revisions
}
function revisionWhere(revisions: SnapshotRevision[]): Prisma.CaseWhereInput {
  return {
    OR: revisions.map(revision => ({
      id: revision.id,
      updatedAt: revision.updatedAt,
      clinicalRevision: revision.clinicalRevision,
      eventRevision: revision.eventRevision,
      relationalRevision: revision.relationalRevision,
      preop: revision.preopRevision === null
        ? { is: null }
        : { is: { syncRevision: revision.preopRevision } },
      intraop: revision.intraopRevision === null
        ? { is: null }
        : { is: { syncRevision: revision.intraopRevision } },
      postop: revision.postopRevision === null
        ? { is: null }
        : { is: { syncRevision: revision.postopRevision } },
    })),
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

// Shared with the OMOP export so both apply the same spreadsheet-safe policy.
const csvEscape = csvCell

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

export type OmopTableName = Exclude<keyof OmopBundle, "metadata">

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

/**
 * The CSV column set, per table, in OMOP CDM v5.4 column order.
 *
 * This list is the only thing that reaches a CSV file: a field the mapper emits
 * but this list omits is written nowhere and no error is raised. That is how
 * every numeric observation was silently dropped — OBSERVATION gained
 * `value_as_number`, ~22 scores started arriving as real numbers, and the eight
 * columns below wrote out the string form only. `omopCsvColumnsMatchMapper` in
 * the test suite now holds this list against the keys the mapper actually
 * produces, so the next added field fails a test instead of vanishing.
 *
 * `value_as_number` sits immediately before `value_as_string` here because that
 * is CDM v5.4's order for OBSERVATION, and it matches where MEASUREMENT below
 * puts its own `value_as_number` — directly after the type concept.
 */
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
    "observation_type_concept_id", "value_as_number", "value_as_string",
    "observation_source_value", "visit_occurrence_id",
  ],
}

/**
 * The header line and the value lines are produced from one list, so a header
 * can never describe a column the rows do not carry, or omit one they do.
 * Exported for the regression test, which asserts against the text a researcher
 * actually downloads rather than against the declaration above.
 */
export function omopCsvHeaderLine(table: OmopTableName): string {
  return `${OMOP_COLUMNS[table].join(",")}\n`
}

export function omopCsvValueLine(
  table: OmopTableName,
  row: Record<string, unknown>,
): string {
  return `${OMOP_COLUMNS[table].map(column => csvEscape(row[column])).join(",")}\n`
}

/** The declared column set, for tests that hold it against the mapper output. */
export function omopCsvColumns(table: OmopTableName): readonly string[] {
  return OMOP_COLUMNS[table]
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
type OmopSpoolFormat = "csv" | "json"
type OmopSpoolSink = {
  key: string
  sink: Awaited<ReturnType<ReturnType<typeof researchExportStorage>["create"]>>
  first: boolean
}

type OmopPreparedExport = {
  keys: Record<OmopTableName, string>
  metadata: OmopBundle["metadata"]
}

function workingArtifactKeys(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((key): key is string => typeof key === "string" && key.length > 0)
    : []
}

async function removeArtifactKeys(keys: readonly string[]): Promise<void> {
  const storage = researchExportStorage()
  for (const key of new Set(keys)) await storage.remove(key)
}

async function persistWorkingKeys(record: ClaimedExport, keys: readonly string[]): Promise<void> {
  const updated = await prisma.researchExport.updateMany({
    where: { id: record.id, status: "RUNNING", leaseOwner: record.leaseOwner },
    data: { workingArtifactKeys: [...keys] },
  })
  if (updated.count !== 1) {
    throw new ResearchExportError("RESEARCH_EXPORT_LEASE_LOST", 409, "Export worker lease was lost")
  }
}

async function prepareOmopExport(
  record: ClaimedExport,
  definition: ResearchCohortDefinition,
  revisions: SnapshotRevision[],
  format: OmopSpoolFormat,
): Promise<OmopPreparedExport> {
  const storage = researchExportStorage()
  const extension = format === "csv" ? "csv" : "json-fragment"
  const contentType = format === "csv" ? "text/csv; charset=utf-8" : "application/octet-stream"
  const sinks = {} as Record<OmopTableName, OmopSpoolSink>
  try {
    for (const table of OMOP_TABLES) {
      const key = `${record.id}/${record.leaseOwner}/spool/${table}.${extension}`
      sinks[table] = {
        key,
        sink: await storage.create(key, contentType),
        first: true,
      }
      sinks[table].sink.done.catch(() => undefined)
    }
  } catch (error) {
    const created = Object.values(sinks)
    for (const item of created) item.sink.writable.destroy()
    await Promise.all(created.map(item => item.sink.done.catch(() => undefined)))
    await removeArtifactKeys(created.map(item => item.key)).catch(() => undefined)
    throw error
  }
  const keys = Object.fromEntries(OMOP_TABLES.map(table => [table, sinks[table].key])) as Record<OmopTableName, string>

  try {
    await persistWorkingKeys(record, Object.values(keys))
    if (format === "csv") {
      for (const table of OMOP_TABLES) {
        await writeChunk(sinks[table].sink.writable, omopCsvHeaderLine(table))
      }
    }

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
      rowIdStart += sequentialOmopRows(bundle)

      for (const table of OMOP_TABLES) {
        const rows = bundle[table] as unknown as Record<string, unknown>[]
        tableCounts[table] += rows.length
        for (const row of rows) {
          if (format === "csv") {
            await writeChunk(sinks[table].sink.writable, omopCsvValueLine(table, row))
          } else {
            await writeChunk(
              sinks[table].sink.writable,
              `${sinks[table].first ? "" : ","}${JSON.stringify(row)}`,
            )
            sinks[table].first = false
          }
        }
      }

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

    for (const table of OMOP_TABLES) {
      if (!sinks[table].sink.writable.writableEnded) sinks[table].sink.writable.end()
    }
    await Promise.all(OMOP_TABLES.map(table => sinks[table].sink.done))

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
    return { keys, metadata }
  } catch (error) {
    for (const table of OMOP_TABLES) {
      sinks[table].sink.writable.destroy()
    }
    await Promise.all(OMOP_TABLES.map(table => sinks[table].sink.done.catch(() => undefined)))
    try {
      await removeArtifactKeys(Object.values(keys))
      await clearWorkingArtifactKeys(record)
    } catch (cleanupError) {
      console.error("[research export] failed to clean OMOP spools", record.id, cleanupError)
    }
    throw error
  }
}

function frozenOmopMetadata(
  record: ClaimedExport,
  metadata: OmopBundle["metadata"],
) {
  return {
    ...metadata,
    definition_hash: record.definitionHash,
    as_of: record.asOf?.toISOString(),
    snapshot_hash: record.snapshotHash,
    revision_manifest_version: record.revisionManifestVersion,
  }
}

async function nodeReadableForArtifact(key: string): Promise<Readable> {
  const artifact = await researchExportStorage().open(key)
  const reader = artifact.stream.getReader()
  return Readable.from((async function* () {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield Buffer.from(chunk.value)
    }
  })())
}

async function copyStoredArtifact(output: Writable, key: string): Promise<void> {
  const artifact = await researchExportStorage().open(key)
  const reader = artifact.stream.getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return
    await writeChunk(output, Buffer.from(chunk.value))
  }
}

async function writeOmopZip(
  output: Writable,
  record: ClaimedExport,
  prepared: OmopPreparedExport,
): Promise<void> {
  const archive = new ZipArchive({ zlib: { level: 6 } })
  const archiveFailure = new Promise<never>((_resolve, reject) => {
    archive.on("warning", (error: Error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") reject(error)
    })
    archive.on("error", reject)
  })

  archive.pipe(output)
  archive.append(JSON.stringify(frozenOmopMetadata(record, prepared.metadata), null, 2), {
    name: "manifest.json",
  })
  for (const table of OMOP_TABLES) {
    archive.append(await nodeReadableForArtifact(prepared.keys[table]), {
      name: `${table}.csv`,
    })
  }
  await Promise.race([archive.finalize(), archiveFailure])
}

async function writeOmopJson(
  output: Writable,
  record: ClaimedExport,
  prepared: OmopPreparedExport,
): Promise<void> {
  await writeChunk(output, `{"metadata":${JSON.stringify(frozenOmopMetadata(record, prepared.metadata))}`)
  for (const table of OMOP_TABLES) {
    await writeChunk(output, `,"${table}":[`)
    await copyStoredArtifact(output, prepared.keys[table])
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

async function clearWorkingArtifactKeys(record: ClaimedExport): Promise<void> {
  const updated = await prisma.researchExport.updateMany({
    where: { id: record.id, status: "RUNNING", leaseOwner: record.leaseOwner },
    data: { workingArtifactKeys: Prisma.DbNull },
  })
  if (updated.count !== 1) {
    throw new ResearchExportError("RESEARCH_EXPORT_LEASE_LOST", 409, "Export worker lease was lost")
  }
}

async function cleanupStaleWorkingArtifacts(record: ClaimedExport): Promise<void> {
  const keys = workingArtifactKeys(record.workingArtifactKeys)
  if (!keys.length) return
  await removeArtifactKeys(keys)
  await clearWorkingArtifactKeys(record)
}

export async function processResearchExport(exportId?: string): Promise<ResearchExportRecord | null> {
  const record = await claimResearchExport(exportId)
  if (!record) return null
  if (!record.leaseOwner || !record.artifactFilename || !record.artifactContentType) {
    throw new ResearchExportError("RESEARCH_EXPORT_INVALID", 409, "Export record is incomplete")
  }

  let artifactKey: string | null = null
  let spoolKeys: string[] = []
  try {
    await cleanupStaleWorkingArtifacts(record)
    await workerContext(record)
    const snapshot = snapshotManifest(record)
    const revisions = snapshot.revisions
    await renewLease(record)

    artifactKey = `${record.id}/${record.leaseOwner}/${record.artifactFilename}`
    const format = record.format as ResearchExportFormat
    let artifact: { checksum: string; byteSize: number }

    if (format === "csv" || format === "json") {
      await persistWorkingKeys(record, [artifactKey])
      artifact = await writeArtifact(artifactKey, record.artifactContentType, output =>
        writeSummaryArtifact(output, format, record, revisions))
    } else {
      const spoolFormat: OmopSpoolFormat = format === "omop-csv" ? "csv" : "json"
      const prepared = await prepareOmopExport(
        record,
        snapshot.definition,
        revisions,
        spoolFormat,
      )
      spoolKeys = Object.values(prepared.keys)
      await persistWorkingKeys(record, [...spoolKeys, artifactKey])
      artifact = await writeArtifact(artifactKey, record.artifactContentType, output =>
        format === "omop-csv"
          ? writeOmopZip(output, record, prepared)
          : writeOmopJson(output, record, prepared))
      await removeArtifactKeys(spoolKeys)
      spoolKeys = []
      await persistWorkingKeys(record, [artifactKey])
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
        artifactExpiresAt: artifactExpiry(completedAt),
        artifactDeletedAt: null,
        workingArtifactKeys: Prisma.DbNull,
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
    let workingArtifactsCleaned = true
    if (artifactKey) {
      try {
        await researchExportStorage().remove(artifactKey)
      } catch (cleanupError) {
        workingArtifactsCleaned = false
        console.error("[research export] failed to clean final working artifact", record.id, cleanupError)
      }
    }
    if (spoolKeys.length) {
      try {
        await removeArtifactKeys(spoolKeys)
      } catch (cleanupError) {
        workingArtifactsCleaned = false
        console.error("[research export] failed to clean OMOP spools", record.id, cleanupError)
      }
    }
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
        ...(workingArtifactsCleaned ? { workingArtifactKeys: Prisma.DbNull } : {}),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    }).catch(() => undefined)
    throw error
  }
}

export type ResearchExportCleanupResult = {
  expiredArtifacts: number
  workingArtifacts: number
  failures: number
}

export async function cleanupResearchExportArtifacts(limit = 100): Promise<ResearchExportCleanupResult> {
  const cappedLimit = Math.min(500, Math.max(1, limit))
  const now = new Date()
  const result: ResearchExportCleanupResult = {
    expiredArtifacts: 0,
    workingArtifacts: 0,
    failures: 0,
  }

  const expired = await prisma.researchExport.findMany({
    where: {
      status: "COMPLETE",
      artifactKey: { not: null },
      artifactDeletedAt: null,
      artifactExpiresAt: { lte: now },
    },
    select: { id: true, artifactKey: true },
    orderBy: { artifactExpiresAt: "asc" },
    take: cappedLimit,
  })
  for (const record of expired) {
    try {
      await researchExportStorage().remove(record.artifactKey!)
      const updated = await prisma.researchExport.updateMany({
        where: { id: record.id, artifactKey: record.artifactKey, artifactDeletedAt: null },
        data: { artifactKey: null, artifactDeletedAt: new Date() },
      })
      result.expiredArtifacts += updated.count
    } catch (error) {
      result.failures += 1
      console.error("[research export cleanup] expired artifact", record.id, error)
    }
  }

  const abandoned = await prisma.researchExport.findMany({
    where: {
      workingArtifactKeys: { not: Prisma.DbNull },
      OR: [
        { status: "FAILED" },
        { status: "PENDING" },
        { status: "RUNNING", leaseExpiresAt: { lte: now } },
      ],
    },
    select: { id: true, workingArtifactKeys: true },
    orderBy: { createdAt: "asc" },
    take: cappedLimit,
  })
  for (const record of abandoned) {
    const keys = workingArtifactKeys(record.workingArtifactKeys)
    if (!keys.length) continue
    try {
      await removeArtifactKeys(keys)
      const updated = await prisma.researchExport.updateMany({
        where: { id: record.id, workingArtifactKeys: { not: Prisma.DbNull } },
        data: { workingArtifactKeys: Prisma.DbNull },
      })
      result.workingArtifacts += updated.count
    } catch (error) {
      result.failures += 1
      console.error("[research export cleanup] working artifacts", record.id, error)
    }
  }

  return result
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
  if (record.status === "PENDING" || record.status === "RUNNING") {
    throw new ResearchExportError("RESEARCH_EXPORT_NOT_READY", 409, "Export is still being generated")
  }
  if (record.status === "FAILED") {
    throw new ResearchExportError("RESEARCH_EXPORT_FAILED", 422, record.error ?? "Export failed")
  }
  if (
    record.artifactDeletedAt ||
    (record.artifactExpiresAt && record.artifactExpiresAt.getTime() <= Date.now())
  ) {
    throw new ResearchExportError(
      "RESEARCH_EXPORT_ARTIFACT_EXPIRED",
      410,
      "This export artifact has expired; create a new export",
    )
  }
  if (record.legacy || !record.artifactKey) {
    throw new ResearchExportError(
      "RESEARCH_EXPORT_LEGACY",
      410,
      "This export predates immutable artifacts and must be recreated",
    )
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
