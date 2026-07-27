import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"

describe.skipIf(!runPostgres)("research governance PostgreSQL integration", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let resolveResearchContext: typeof import("@/lib/research/access").resolveResearchContext
  let researchContextForAction: typeof import("@/lib/research/access").researchContextForAction
  let runResearchQuery: typeof import("@/lib/research/service").runResearchQuery
  let runResearchCaseQuery: typeof import("@/lib/research/service").runResearchCaseQuery
  let createResearchExport: typeof import("@/lib/research/exports").createResearchExport
  let processResearchExport: typeof import("@/lib/research/exports").processResearchExport
  let openResearchExport: typeof import("@/lib/research/exports").openResearchExport

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

  beforeAll(async () => {
    artifactRoot = await mkdtemp(join(tmpdir(), "lospor-research-postgres-"))
    process.env.RESEARCH_EXPORT_STORAGE_DRIVER = "filesystem"
    process.env.RESEARCH_EXPORT_STORAGE_DIR = artifactRoot
    delete process.env.VERCEL

    ;({ prisma } = await import("@/lib/prisma"))
    ;({ resolveResearchContext, researchContextForAction } = await import("@/lib/research/access"))
    ;({ runResearchQuery, runResearchCaseQuery } = await import("@/lib/research/service"))
    ;({
      createResearchExport,
      processResearchExport,
      openResearchExport,
    } = await import("@/lib/research/exports"))

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
      { id: caseA, userId: researcherId, institutionId: institutionA, caseCode: "RG-A1", status: "COMPLETE", finalizedAt: new Date("2026-07-01T10:00:00.000Z") },
      { id: caseB, userId: researcherId, institutionId: institutionB, caseCode: "RG-B1", status: "COMPLETE", finalizedAt: new Date("2026-07-01T11:00:00.000Z") },
    ] })
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

  it("fails visibly when a queued export source revision changes", async () => {
    const context = await resolveResearchContext(user)
    const queued = await createResearchExport(context!, {
      name: "Revision drift integration export",
      format: "csv",
      definition: cohort,
    })
    expect(queued).toMatchObject({ matchingCases: 1, status: "PENDING" })
    expect(queued.snapshotHash).toMatch(/^[a-f0-9]{64}$/)

    await prisma.case.update({ where: { id: caseA }, data: { caseCode: "RG-A-DRIFT" } })
    await expect(processResearchExport(queued.id)).rejects.toMatchObject({
      code: "RESEARCH_EXPORT_SNAPSHOT_CHANGED",
    })
    await expect(prisma.researchExport.findUniqueOrThrow({ where: { id: queued.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        rowCount: null,
        artifactKey: null,
      })
    await prisma.case.update({ where: { id: caseA }, data: { caseCode: "RG-A1" } })
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
