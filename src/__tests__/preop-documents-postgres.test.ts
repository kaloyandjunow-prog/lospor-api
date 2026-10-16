import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"
import type { Prisma } from "@/generated/prisma/client"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * The preop summary and written consent settings (9.15.0), against a real
 * database. Every test runs inside a transaction that is rolled back: a saved
 * consent text can never be deleted, by design, so nothing may be committed.
 */
describe.skipIf(!runPostgres)("preop documents in PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let documents: typeof import("@/lib/preop/documents")
  const ROLLBACK = new Error("rollback")

  async function inRollback(run: (tx: Prisma.TransactionClient, ids: { userId: string; caseId: string }) => Promise<void>, status: "IN_PROGRESS" | "COMPLETE" = "IN_PROGRESS") {
    const userId = `preop-documents-user-${randomUUID()}`
    const caseId = `preop-documents-case-${randomUUID()}`
    await prisma.$transaction(async tx => {
      await tx.user.create({ data: { id: userId, email: `${userId}@example.test`, username: userId, usernameCanonical: userId.toLowerCase(), name: "Preop documents test", passwordHash: "not-a-real-password" } })
      await tx.case.create({ data: { id: caseId, userId, createdById: userId, status: "IN_PROGRESS" } })
      if (status === "COMPLETE") await tx.case.update({ where: { id: caseId }, data: { status: "COMPLETE" } })
      await run(tx, { userId, caseId })
      throw ROLLBACK
    }, { timeout: 20_000 }).catch(error => { if (error !== ROLLBACK) throw error })
  }

  const turnOn = (tx: Prisma.TransactionClient, consentEnabled = true) => tx.preopDocumentPolicy.upsert({
    where: { id: "local" },
    create: { id: "local", summaryEnabled: true, consentEnabled },
    update: { summaryEnabled: true, consentEnabled },
  })

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    documents = await import("@/lib/preop/documents")
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  it("is off with no policy row, and sends no texts", async () => {
    await inRollback(async tx => {
      await tx.preopDocumentPolicy.deleteMany({})
      expect(await documents.preopDocuments(tx)).toEqual({ summaryEnabled: false, consentEnabled: false, templates: null })
    })
  })

  it("sends the bundled texts as version 0, then a hospital's latest save", async () => {
    await inRollback(async (tx, { userId }) => {
      await turnOn(tx)
      const before = await documents.preopDocuments(tx)
      if ((before.templates?.ADULT.version ?? 0) > 0) return // a dev database where Status has saved texts
      expect(before.templates?.PEDIATRIC).toMatchObject({ version: 0, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
      const body = "## Анестезия\n\nТекст на болницата."
      await tx.consentTemplateVersion.create({ data: { population: "ADULT", version: 1, title: "Съгласие", body, sha256: documents.consentTextSha256(body), createdById: userId } })
      const after = await documents.preopDocuments(tx)
      expect(after.templates?.ADULT).toMatchObject({ version: 1, body })
      expect(after.templates?.PEDIATRIC.version).toBe(0)
    })
  })

  it("records a print of the bundled text, and refuses a fingerprint it does not know", async () => {
    await inRollback(async (tx, { userId, caseId }) => {
      await turnOn(tx)
      const bundled = (await documents.currentConsentTemplates(tx)).PEDIATRIC
      if (bundled.version !== 0) return
      const print = await documents.recordConsentPrint(tx, { caseId, userId, print: { population: "PEDIATRIC", version: 0, sha256: bundled.sha256 } })
      expect(print).toMatchObject({ caseId, templateVersion: 0, bodySha256: bundled.sha256, printedById: userId })
      expect(await tx.auditLog.count({ where: { userId, action: "CASE_CONSENT_PRINTED", entityId: caseId } })).toBe(1)
      await expect(documents.recordConsentPrint(tx, { caseId, userId, print: { population: "PEDIATRIC", version: 0, sha256: "0".repeat(64) } }))
        .rejects.toMatchObject({ code: "CONSENT_TEXT_MISMATCH" })
    })
  })

  it("records nothing while the consent is switched off", async () => {
    await inRollback(async (tx, { userId, caseId }) => {
      await turnOn(tx, false)
      await expect(documents.recordConsentPrint(tx, { caseId, userId, print: { population: "ADULT", version: 0, sha256: "0".repeat(64) } }))
        .rejects.toMatchObject({ code: "CONSENT_DISABLED" })
    })
  })

  it("never rewrites a saved text", async () => {
    await inRollback(async (tx, { userId }) => {
      const saved = await tx.consentTemplateVersion.create({ data: { population: "PEDIATRIC", version: 9_999, title: "Съгласие", body: "Текст", sha256: documents.consentTextSha256("Текст"), createdById: userId } })
      await expect(tx.consentTemplateVersion.update({ where: { id: saved.id }, data: { body: "Друг текст" } })).rejects.toThrow(/CONSENT_TEMPLATE_IMMUTABLE/)
    })
  })

  it("takes no print onto a finalised case", async () => {
    await inRollback(async (tx, { userId, caseId }) => {
      await expect(tx.caseConsentPrint.create({ data: { caseId, population: "ADULT", templateVersion: 0, bodySha256: "0".repeat(64), printedById: userId } }))
        .rejects.toThrow(/CASE_FINALIZED/)
    }, "COMPLETE")
  })
})
