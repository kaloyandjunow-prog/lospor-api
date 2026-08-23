import { createHash, randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * Finalization records append; they are never rewritten.
 *
 * CaseSnapshot called itself immutable, held `caseId` UNIQUE, and was written
 * with an upsert whose update branch replaced the document and its timestamp.
 * finalize -> unfinalize -> edit -> finalize therefore destroyed the original
 * attestation with no trace, and the surviving row kept the schemaVersion it
 * was first created with over a document of a different shape.
 *
 * These run against PostgreSQL because half the guarantee is a trigger.
 */
describe.skipIf(!runPostgres)("append-only finalization records", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let writeSnapshotAsync: typeof import("@/lib/case-audit").writeSnapshotAsync

  const suffix = randomUUID()
  const userId = `finalization-user-${suffix}`
  const caseIds: string[] = []

  async function createCase() {
    const caseId = `finalization-case-${randomUUID()}`
    caseIds.push(caseId)
    await prisma.case.create({ data: { id: caseId, userId, createdById: userId, status: "IN_PROGRESS" } })
    return caseId
  }

  // The lifecycle the old implementation could not survive.
  async function finalize(caseId: string, reason?: string) {
    await prisma.case.update({
      where: { id: caseId },
      data: { status: "COMPLETE", finalizedAt: new Date() },
    })
    await writeSnapshotAsync(prisma, caseId, userId, reason)
  }

  async function unfinalize(caseId: string) {
    await prisma.case.update({
      where: { id: caseId },
      data: { status: "IN_PROGRESS", finalizedAt: null },
    })
  }

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ writeSnapshotAsync } = await import("@/lib/case-audit"))
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        name: "Finalization test",
        passwordHash: "not-a-real-password",
      },
    })
  })

  afterEach(async () => {
    await prisma.case.deleteMany({ where: { id: { in: caseIds.splice(0) } } })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
  })

  it("keeps the original record when a case is corrected", async () => {
    const caseId = await createCase()
    await prisma.case.update({ where: { id: caseId }, data: { notes: "first" } })
    await finalize(caseId)

    await unfinalize(caseId)
    await prisma.case.update({ where: { id: caseId }, data: { notes: "corrected" } })
    await finalize(caseId, "typo in the notes")

    const rows = await prisma.caseFinalization.findMany({
      where: { caseId },
      orderBy: { sequence: "asc" },
    })
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.sequence)).toEqual([1, 2])
    // The whole point: what was first attested to is still there.
    expect(JSON.parse(rows[0].snapshotDocument).notes).toBe("first")
    expect(JSON.parse(rows[1].snapshotDocument).notes).toBe("corrected")
  })

  it("links each correction to the record it supersedes", async () => {
    const caseId = await createCase()
    await finalize(caseId)
    await unfinalize(caseId)
    await finalize(caseId, "second look")

    const [first, second] = await prisma.caseFinalization.findMany({
      where: { caseId },
      orderBy: { sequence: "asc" },
    })
    expect(first.supersedesFinalizationId).toBeNull()
    expect(second.supersedesFinalizationId).toBe(first.id)
    expect(second.correctionReason).toBe("second look")
  })

  it("records who finalized, and the schema version of each document", async () => {
    // The old update branch never set schemaVersion, so a rewritten snapshot
    // kept the version it was first created with over a differently shaped one.
    const caseId = await createCase()
    await finalize(caseId)
    await unfinalize(caseId)
    await finalize(caseId, "again")

    const rows = await prisma.caseFinalization.findMany({ where: { caseId } })
    expect(rows.every(row => row.finalizedById === userId)).toBe(true)
    expect(rows.every(row => row.schemaVersion === "4.0.0")).toBe(true)
  })

  it("hashes the document it stores", async () => {
    const caseId = await createCase()
    await finalize(caseId)

    const row = await prisma.caseFinalization.findFirstOrThrow({ where: { caseId } })
    const recomputed = createHash("sha256")
      .update(row.snapshotDocument)
      .digest("hex")
    expect(row.snapshotHash).toBe(recomputed)
  })

  it("refuses to let a stored finalization be edited", async () => {
    const caseId = await createCase()
    await finalize(caseId)
    const row = await prisma.caseFinalization.findFirstOrThrow({ where: { caseId } })

    await expect(
      prisma.caseFinalization.update({
        where: { id: row.id },
        data: { snapshotDocument: "{\"tampered\":true}" },
      }),
    ).rejects.toThrow(/FINALIZATION_IMMUTABLE/)

    const after = await prisma.caseFinalization.findFirstOrThrow({ where: { id: row.id } })
    expect(after.snapshotDocument).toBe(row.snapshotDocument)
  })

  it("refuses to let a stored finalization be deleted", async () => {
    const caseId = await createCase()
    await finalize(caseId)
    const row = await prisma.caseFinalization.findFirstOrThrow({ where: { caseId } })

    await expect(
      prisma.caseFinalization.delete({ where: { id: row.id } }),
    ).rejects.toThrow(/FINALIZATION_IMMUTABLE/)
    expect(await prisma.caseFinalization.count({ where: { id: row.id } })).toBe(1)
  })

  it("still lets erasure of the case remove its finalizations", async () => {
    // Deleting the parent is the retention and erasure path, and must not be
    // blocked by a guard meant to stop rewriting history in place.
    const caseId = await createCase()
    await finalize(caseId)
    expect(await prisma.caseFinalization.count({ where: { caseId } })).toBe(1)

    await prisma.case.delete({ where: { id: caseId } })
    caseIds.splice(caseIds.indexOf(caseId), 1)
    expect(await prisma.caseFinalization.count({ where: { caseId } })).toBe(0)
  })

  it("will not allow two finalizations to claim the same position", async () => {
    const caseId = await createCase()
    await finalize(caseId)
    const existing = await prisma.caseFinalization.findFirstOrThrow({ where: { caseId } })

    await expect(prisma.caseFinalization.create({
      data: {
        caseId,
        sequence: existing.sequence,
        schemaVersion: "4.0.0",
        snapshotDocument: "{}",
        snapshotHash: "x",
      },
    })).rejects.toThrow()
  })
})
