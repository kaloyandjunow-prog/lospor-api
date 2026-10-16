import { createHash } from "node:crypto"
import { z } from "zod"
import { ClinicalMode, type Prisma, type PrismaClient } from "@/generated/prisma/client"
import { logAuditInTransaction } from "@/lib/audit"
import {
  BUNDLED_CONSENT_TEMPLATES,
  canonicalConsentText,
  CONSENT_POPULATIONS,
  effectivePreopDocumentSettings,
  type ConsentPopulation,
  type ConsentTemplateVersionView,
  type PreopDocumentsResponse,
} from "@lospor/core/preop-documents"

type Db = PrismaClient | Prisma.TransactionClient

/** The fingerprint a printed sheet records: SHA-256 of Core's canonical text. */
export function consentTextSha256(body: string): string {
  return createHash("sha256").update(canonicalConsentText(body), "utf8").digest("hex")
}

function bundledView(population: ConsentPopulation): ConsentTemplateVersionView {
  const template = BUNDLED_CONSENT_TEMPLATES[population]
  return { population, version: 0, title: template.title, body: template.body, sha256: consentTextSha256(template.body) }
}

/** The text a population prints today: the hospital's latest save, or the bundled one. */
export async function currentConsentTemplates(db: Db): Promise<Record<ConsentPopulation, ConsentTemplateVersionView>> {
  const entries = await Promise.all(CONSENT_POPULATIONS.map(async population => {
    const latest = await db.consentTemplateVersion.findFirst({
      where: { population: population as ClinicalMode },
      orderBy: { version: "desc" },
    })
    const view: ConsentTemplateVersionView = latest
      ? { population, version: latest.version, title: latest.title, body: latest.body, sha256: latest.sha256 }
      : bundledView(population)
    return [population, view] as const
  }))
  return Object.fromEntries(entries) as Record<ConsentPopulation, ConsentTemplateVersionView>
}

/**
 * What the apps need to know: whether the summary page and the consent are
 * on, and, when the consent is, the texts it prints. No row means both off
 * (every serverless demo, and an appliance nobody has configured).
 */
export async function preopDocuments(db: Db): Promise<PreopDocumentsResponse> {
  const policy = await db.preopDocumentPolicy.findUnique({ where: { id: "local" } })
  const settings = effectivePreopDocumentSettings(policy)
  return { ...settings, templates: settings.consentEnabled ? await currentConsentTemplates(db) : null }
}

export const consentPrintSchema = z.object({
  population: z.enum(["ADULT", "PEDIATRIC"]),
  version: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

export class ConsentPrintError extends Error {
  constructor(readonly code: "CONSENT_DISABLED" | "CONSENT_TEXT_MISMATCH") {
    super(code)
  }
}

/**
 * Records that a consent was printed for a case, with the version and
 * fingerprint of its text. The client says which text it printed; the
 * record is accepted only if that is a text the site has (the bundled one or
 * a saved version), so a sheet's fingerprint always resolves to words.
 */
export async function recordConsentPrint(
  tx: Prisma.TransactionClient,
  input: { caseId: string; userId: string; print: z.infer<typeof consentPrintSchema> },
) {
  const policy = await tx.preopDocumentPolicy.findUnique({ where: { id: "local" } })
  if (!effectivePreopDocumentSettings(policy).consentEnabled) throw new ConsentPrintError("CONSENT_DISABLED")
  const { population, version, sha256 } = input.print
  let templateVersionId: string | null = null
  if (version === 0) {
    if (bundledView(population).sha256 !== sha256) throw new ConsentPrintError("CONSENT_TEXT_MISMATCH")
  } else {
    const saved = await tx.consentTemplateVersion.findUnique({
      where: { population_version: { population: population as ClinicalMode, version } },
    })
    if (!saved || saved.sha256 !== sha256) throw new ConsentPrintError("CONSENT_TEXT_MISMATCH")
    templateVersionId = saved.id
  }
  const print = await tx.caseConsentPrint.create({
    data: { caseId: input.caseId, population: population as ClinicalMode, templateVersion: version, templateVersionId, bodySha256: sha256, printedById: input.userId },
  })
  await logAuditInTransaction(tx, input.userId, "CASE_CONSENT_PRINTED", input.caseId, { population, templateVersion: version, bodySha256: sha256 })
  return print
}
