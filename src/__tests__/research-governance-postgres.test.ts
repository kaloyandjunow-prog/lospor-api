import { randomUUID } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"
import { API_RELEASE_VERSION } from "@/lib/api-version"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

describe.skipIf(!runPostgres)("research governance PostgreSQL integration", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let resolveResearchContext: typeof import("@/lib/research/access").resolveResearchContext
  let researchContextForAction: typeof import("@/lib/research/access").researchContextForAction
  let runResearchQuery: typeof import("@/lib/research/service").runResearchQuery
  let runResearchCaseQuery: typeof import("@/lib/research/service").runResearchCaseQuery
  let createResearchExport: typeof import("@/lib/research/exports").createResearchExport
  let processResearchExport: typeof import("@/lib/research/exports").processResearchExport
  let cleanupResearchExportArtifacts: typeof import("@/lib/research/exports").cleanupResearchExportArtifacts
  let openResearchExport: typeof import("@/lib/research/exports").openResearchExport
  let writeSnapshotAsync: typeof import("@/lib/case-audit").writeSnapshotAsync

  const suffix = randomUUID()
  const institutionA = `research-a-${suffix}`
  const institutionB = `research-b-${suffix}`
  const adminId = `research-admin-${suffix}`
  const researcherId = `research-user-${suffix}`
  const caseA = `research-case-a-${suffix}`
  const caseB = `research-case-b-${suffix}`
  let grantA = ""
  let artifactRoot = ""

  const user = {
    id: researcherId,
    role: "RESEARCHER",
    institutionId: null,
    institutionName: null,
    firstName: "Research",
    lastName: "Tester",
    title: null,
    jti: null,
  } as const
  const cohort = { version: 1 as const, filters: { statuses: ["COMPLETE" as const] } }

  async function streamText(stream: ReadableStream<Uint8Array>) {
    const chunks: Uint8Array[] = []
    const reader = stream.getReader()
    while (true) {
      const result = await reader.read()
      if (result.done) break
      chunks.push(result.value)
    }
    return Buffer.concat(chunks).toString("utf8")
  }

  async function finalizeCaseA() {
    const finalizedAt = new Date()
    await prisma.case.update({
      where: { id: caseA },
      data: { status: "COMPLETE", finalizedAt },
    })
    await writeSnapshotAsync(prisma, caseA)
  }

  beforeAll(async () => {
    artifactRoot = await mkdtemp(join(tmpdir(), "lospor-research-postgres-"))
    process.env.RESEARCH_EXPORT_STORAGE_DRIVER = "filesystem"
    process.env.RESEARCH_EXPORT_STORAGE_DIR = artifactRoot
    process.env.RESEARCH_EXPORT_RETENTION_DAYS = "30"
    delete process.env.VERCEL

    ;({ prisma } = await import("@/lib/prisma"))
    ;({ resolveResearchContext, researchContextForAction } = await import("@/lib/research/access"))
    ;({ runResearchQuery, runResearchCaseQuery } = await import("@/lib/research/service"))
    ;({
      createResearchExport,
      processResearchExport,
      cleanupResearchExportArtifacts,
      openResearchExport,
    } = await import("@/lib/research/exports"))
    ;({ writeSnapshotAsync } = await import("@/lib/case-audit"))

    await prisma.institution.createMany({ data: [
      { id: institutionA, name: "Research Hospital A", city: "Sofia" },
      { id: institutionB, name: "Research Hospital B", city: "Plovdiv" },
    ] })
    await prisma.user.createMany({ data: [
      { id: adminId, email: `${adminId}@example.test`, name: "Research admin", passwordHash: "test", role: "ADMIN" },
      { id: researcherId, email: `${researcherId}@example.test`, name: "Researcher", passwordHash: "test", role: "RESEARCHER" },
    ] })
    const grants = await Promise.all([
      prisma.researchAccessGrant.create({ data: {
        userId: researcherId, institutionId: institutionA, grantedById: adminId,
        canInspectCases: true, canExport: true, canExportOmop: false,
      } }),
      prisma.researchAccessGrant.create({ data: {
        userId: researcherId, institutionId: institutionB, grantedById: adminId,
        canInspectCases: false, canExport: false, canExportOmop: false,
      } }),
    ])
    grantA = grants[0].id
    await prisma.case.createMany({ data: [
      { id: caseA, userId: researcherId, institutionId: institutionA, caseCode: "RG-A1", status: "IN_PROGRESS" },
      { id: caseB, userId: researcherId, institutionId: institutionB, caseCode: "RG-B1", status: "COMPLETE", finalizedAt: new Date("2026-07-01T11:00:00.000Z") },
    ] })
    await prisma.preoperativeAssessment.create({ data: {
      caseId: caseA,
      sex: "MALE",
      ageYears: 55,
      diagnosis: "Essential hypertension",
      icdCode: "I10",
      plannedProcedure: "Integration test procedure",
    } })
    await prisma.intraoperativeRecord.create({ data: {
      caseId: caseA,
      startedAt: new Date("2026-07-28T08:00:00.000Z"),
      endedAt: new Date("2026-07-28T09:00:00.000Z"),
      timezone: "Europe/Sofia",
      techniques: ["GENERAL_BALANCED"],
    } })
    await prisma.clinicalFieldStatus.create({ data: {
      caseId: caseA,
      section: "preop",
      fieldKey: "diagnosis",
      presence: "PRESENT",
      source: "integration-test",
    } })
    await finalizeCaseA()
  })

  afterAll(async () => {
    if (prisma) {
      await prisma.researchExport.deleteMany({ where: { ownerId: researcherId } })
      await prisma.researchAccessGrant.deleteMany({ where: { userId: researcherId } })
      await prisma.case.deleteMany({ where: { id: { in: [caseA, caseB] } } })
      await prisma.user.deleteMany({ where: { id: { in: [researcherId, adminId] } } })
      await prisma.institution.deleteMany({ where: { id: { in: [institutionA, institutionB] } } })
      await prisma.$disconnect()
    }
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true })
  })

  it("keeps aggregate, inspection, and export grants inside their own institutions", async () => {
    const context = await resolveResearchContext(user)
    expect(context).not.toBeNull()
    expect(context!.actionScopes.query.institutionIds.sort()).toEqual([institutionA, institutionB].sort())
    expect(context!.actionScopes.inspectCases.institutionIds).toEqual([institutionA])
    expect(context!.actionScopes.export.institutionIds).toEqual([institutionA])

    const aggregate = await runResearchQuery({ cohort, metrics: ["caseCount"], distributions: [] }, context!)
    expect(aggregate.matchingCases).toBeNull()
    expect(aggregate.matchingCaseCount).toMatchObject({ exact: false, suppressed: true })
    expect(aggregate.cases).toEqual([])
    expect(aggregate.pagination).toBeNull()

    const inspected = await runResearchCaseQuery(
      { cohort, pagination: { take: 20 } },
      researchContextForAction(context!, "inspectCases"),
    )
    expect(inspected.matchingCases).toBe(1)
    expect(inspected.cases.map(item => item.researchId)).toEqual(["RG-A1"])
  })

  it("rejects research exports unless the cohort is finalized-only", async () => {
    const context = await resolveResearchContext(user)
    await expect(createResearchExport(context!, {
      name: "Unsafe draft export",
      format: "csv",
      definition: { version: 1, filters: { statuses: ["IN_PROGRESS"] } },
    })).rejects.toMatchObject({
      code: "RESEARCH_EXPORT_FINALIZED_ONLY",
      status: 422,
    })
  })

  it("captures every clinical revision and rejects event drift before generation", async () => {
    const context = await resolveResearchContext(user)
    const queued = await createResearchExport(context!, {
      name: "Revision drift integration export",
      format: "csv",
      definition: cohort,
    })
    expect(queued).toMatchObject({
      matchingCases: 1,
      status: "PENDING",
      revisionManifestVersion: 2,
    })
    expect(queued.snapshotHash).toMatch(/^[a-f0-9]{64}$/)

    const stored = await prisma.researchExport.findUniqueOrThrow({ where: { id: queued.id } })
    expect(stored.revisionManifestVersion).toBe(2)
    expect(stored.sourceVersion).toBe(API_RELEASE_VERSION)
    expect(stored.snapshotRevisions).toEqual([
      expect.objectContaining({
        id: caseA,
        clinicalRevision: expect.any(Number),
        eventRevision: 0,
        relationalRevision: 0,
        preopRevision: 0,
        intraopRevision: 0,
        postopRevision: null,
        updatedAt: expect.any(String),
      }),
    ])

    await prisma.case.update({
      where: { id: caseA },
      data: { status: "IN_PROGRESS", finalizedAt: null },
    })
    await prisma.caseEvent.create({ data: {
      caseId: caseA,
      userId: researcherId,
      logicalId: `research-event-${suffix}`,
      type: "clinical_event",
      timestamp: new Date("2026-07-28T08:30:00.000Z"),
      label: "Integration event",
      source: "integration-test",
      idempotencyKey: `research-event-${suffix}`,
    } })
    await finalizeCaseA()

    await expect(processResearchExport(queued.id)).rejects.toMatchObject({
      code: "RESEARCH_EXPORT_SNAPSHOT_CHANGED",
    })
    await expect(prisma.researchExport.findUniqueOrThrow({ where: { id: queued.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        rowCount: null,
        artifactKey: null,
      })
  })

  it("generates OMOP once, removes work files, and expires only the artifact", async () => {
    await prisma.researchAccessGrant.update({
      where: { id: grantA },
      data: { canExportOmop: true },
    })
    const context = await resolveResearchContext(user)
    const queued = await createResearchExport(context!, {
      name: "OMOP retention integration export",
      format: "omop-json",
      definition: cohort,
    })
    const completed = await processResearchExport(queued.id)
    expect(completed).toMatchObject({
      status: "COMPLETE",
      rowCount: 1,
      legacy: false,
      revisionManifestVersion: 2,
      artifactAvailable: true,
    })

    const opened = await openResearchExport(context!, queued.id)
    const bundle = JSON.parse(await streamText(opened.stream)) as {
      metadata: { revision_manifest_version: number; matching_case_count: number }
      person: unknown[]
      visit_occurrence: unknown[]
    }
    expect(bundle.metadata).toMatchObject({
      revision_manifest_version: 2,
      matching_case_count: 1,
    })
    expect(bundle.person).toHaveLength(1)
    expect(bundle.visit_occurrence).toHaveLength(1)

    const stored = await prisma.researchExport.findUniqueOrThrow({ where: { id: queued.id } })
    expect(stored.workingArtifactKeys).toBeNull()
    expect(stored.artifactExpiresAt).not.toBeNull()
    expect(stored.checksum).toMatch(/^[a-f0-9]{64}$/)
    const retentionDays = (stored.artifactExpiresAt!.getTime() - stored.completedAt!.getTime()) / 86_400_000
    expect(retentionDays).toBeGreaterThan(29.99)
    expect(retentionDays).toBeLessThan(30.01)
    const files = await readdir(artifactRoot, { recursive: true })
    expect(files.some(file => file.includes("spool"))).toBe(false)

    await prisma.researchExport.update({
      where: { id: queued.id },
      data: { artifactExpiresAt: new Date(Date.now() - 1_000) },
    })
    await expect(cleanupResearchExportArtifacts()).resolves.toMatchObject({
      expiredArtifacts: 1,
      failures: 0,
    })
    const expired = await prisma.researchExport.findUniqueOrThrow({ where: { id: queued.id } })
    expect(expired).toMatchObject({
      artifactKey: null,
      artifactDeletedAt: expect.any(Date),
      checksum: stored.checksum,
      rowCount: 1,
    })
    await expect(openResearchExport(context!, queued.id)).rejects.toMatchObject({
      code: "RESEARCH_EXPORT_ARTIFACT_EXPIRED",
      status: 410,
    })
  })

  it("freezes an artifact and rechecks permission before every download", async () => {
    const context = await resolveResearchContext(user)
    const queued = await createResearchExport(context!, {
      name: "Governed integration export",
      format: "csv",
      definition: cohort,
    })
    const completed = await processResearchExport(queued.id)
    expect(completed).toMatchObject({ status: "COMPLETE", rowCount: 1, legacy: false })

    const first = await openResearchExport(context!, queued.id)
    const firstText = await streamText(first.stream)
    expect(firstText).toContain("RG-A1")
    expect(firstText).not.toContain("RG-B1")

    await prisma.case.update({ where: { id: caseA }, data: { caseCode: "RG-A2" } })
    const second = await openResearchExport(context!, queued.id)
    expect(await streamText(second.stream)).toBe(firstText)

    await prisma.researchAccessGrant.update({ where: { id: grantA }, data: { revokedAt: new Date() } })
    const reducedContext = await resolveResearchContext(user)
    await expect(openResearchExport(reducedContext!, queued.id)).rejects.toMatchObject({
      code: "RESEARCH_EXPORT_FORBIDDEN",
    } satisfies { code: string })
  })
})