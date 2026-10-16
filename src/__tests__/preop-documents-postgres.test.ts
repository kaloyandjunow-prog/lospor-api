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
      expect(await documents.preopDocuments(tx)).toEqual({ summaryEnabled: false, consentEnabled: false, layout: "B", templates: null })
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

  it("records the layout and, for layout C, the techniques the consent described", async () => {
    await inRollback(async (tx, { userId, caseId }) => {
      await turnOn(tx)
      const bundled = (await documents.currentConsentTemplates(tx)).ADULT
      const print = await documents.recordConsentPrint(tx, { caseId, userId, print: { population: "ADULT", version: bundled.version, sha256: bundled.sha256, layout: "C", techniques: ["block", "general", "block"] } })
      expect(print).toMatchObject({ layout: "C", techniques: ["block", "general"] })
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
  it("switches the consent off with the summary, and audits the change", async () => {
    await inRollback(async (tx, { userId }) => {
      const policy = await documents.updatePreopDocumentPolicy(tx, userId, { summaryEnabled: false, consentEnabled: true, reason: "Test change" })
      expect(policy).toMatchObject({ summaryEnabled: false, consentEnabled: false })
      const chosen = await documents.updatePreopDocumentPolicy(tx, userId, { summaryEnabled: true, consentEnabled: true, layout: "E", reason: "Test change" })
      expect(chosen.layout).toBe("E")
      // A request that names no layout keeps the chosen one.
      expect((await documents.updatePreopDocumentPolicy(tx, userId, { summaryEnabled: true, consentEnabled: false, reason: "Test change" })).layout).toBe("E")
      expect(await tx.auditLog.count({ where: { userId, action: "PREOP_DOCUMENTS_POLICY_UPDATE" } })).toBe(3)
      // Last: a refused statement ends the transaction.
      await expect(tx.preopDocumentPolicy.update({ where: { id: "local" }, data: { layout: "Z" } })).rejects.toThrow()
    })
  })

  it("numbers saved texts, saves nothing for the same words, and refuses a bad text", async () => {
    await inRollback(async (tx, { userId }) => {
      const before = await tx.consentTemplateVersion.count({ where: { population: "PEDIATRIC" } })
      const first = await documents.saveConsentTemplate(tx, userId, { population: "PEDIATRIC", title: "Съгласие", body: "## Анестезия\r\n\r\nТекст.  ", reason: "Test" })
      expect(first.version).toBe(before + 1)
      expect(first.body).toBe("## Анестезия\n\nТекст.")
      const again = await documents.saveConsentTemplate(tx, userId, { population: "PEDIATRIC", title: "Съгласие", body: "## Анестезия\n\nТекст.", reason: "Test" })
      expect(again.version).toBe(first.version)
      const second = await documents.saveConsentTemplate(tx, userId, { population: "PEDIATRIC", title: "Съгласие", body: "Друг текст.", reason: "Test" })
      expect(second.version).toBe(first.version + 1)
      const history = await documents.consentTemplateHistory(tx, "PEDIATRIC")
      expect(history.slice(0, 2).map(row => row.version)).toEqual([second.version, first.version])
      expect(history[history.length - 1]?.version).toBe(0)
      await expect(documents.saveConsentTemplate(tx, userId, { population: "PEDIATRIC", title: "Съгласие", body: "{{surgeon}}", reason: "Test" }))
        .rejects.toMatchObject({ code: "CONSENT_TEXT_INVALID", problems: ["UNKNOWN_FIELD"] })
    })
  })
})
