import { createHash } from "node:crypto"
import { z } from "zod"
import { ClinicalMode, type Prisma, type PrismaClient } from "@/generated/prisma/client"
import { logAuditInTransaction } from "@/lib/audit"
import {
  BUNDLED_CONSENT_TEMPLATES,
  canonicalConsentText,
  CONSENT_POPULATIONS,
  CONSENT_TECHNIQUES,
  consentTextProblems,
  effectivePreopDocumentSettings,
  type ConsentPopulation,
  type ConsentTemplateVersionView,
  type PreopDocumentLayout,
  PREOP_DOCUMENT_LAYOUTS,
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

/** The settings as stored; no row is both off, layout B. */
function storedSettings(row: { summaryEnabled: boolean; consentEnabled: boolean; layout: string } | null) {
  return effectivePreopDocumentSettings(row ? { ...row, layout: row.layout as PreopDocumentLayout } : null)
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
  const settings = storedSettings(await db.preopDocumentPolicy.findUnique({ where: { id: "local" } }))
  return { ...settings, templates: settings.consentEnabled ? await currentConsentTemplates(db) : null }
}

export const consentPrintSchema = z.object({
  population: z.enum(["ADULT", "PEDIATRIC"]),
  version: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  layout: z.enum(PREOP_DOCUMENT_LAYOUTS).optional(),
  techniques: z.array(z.enum(CONSENT_TECHNIQUES)).max(CONSENT_TECHNIQUES.length).optional(),
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
  if (!storedSettings(await tx.preopDocumentPolicy.findUnique({ where: { id: "local" } })).consentEnabled) throw new ConsentPrintError("CONSENT_DISABLED")
  const { population, version, sha256, layout, techniques } = input.print
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
    data: {
      caseId: input.caseId,
      population: population as ClinicalMode,
      templateVersion: version,
      templateVersionId,
      bodySha256: sha256,
      layout: layout ?? null,
      techniques: [...new Set(techniques ?? [])],
      printedById: input.userId,
    },
  })
  await logAuditInTransaction(tx, input.userId, "CASE_CONSENT_PRINTED", input.caseId, { population, templateVersion: version, bodySha256: sha256, layout: layout ?? null, techniques: print.techniques })
  return print
}

// ── What Status changes (through the appliance's internal control plane) ──

export class PreopDocumentsContractError extends Error {
  constructor(readonly code: "CONSENT_TEXT_INVALID", readonly problems: readonly string[] = []) {
    super(code)
  }
}

/** Switches the summary page and the consent on or off, and picks the print layout. The consent needs the summary. */
export async function updatePreopDocumentPolicy(
  tx: Prisma.TransactionClient,
  actorId: string,
  input: { summaryEnabled: boolean; consentEnabled: boolean; layout?: PreopDocumentLayout; reason: string },
) {
  const before = storedSettings(await tx.preopDocumentPolicy.findUnique({ where: { id: "local" } }))
  // A request without a layout keeps the one chosen before.
  const settings = effectivePreopDocumentSettings({ ...input, layout: input.layout ?? before.layout })
  const policy = await tx.preopDocumentPolicy.upsert({
    where: { id: "local" },
    create: { id: "local", ...settings, changedById: actorId, changeReason: input.reason },
    update: { ...settings, changedById: actorId, changeReason: input.reason },
  })
  await logAuditInTransaction(tx, actorId, "PREOP_DOCUMENTS_POLICY_UPDATE", policy.id, {
    before,
    after: settings,
    reasonRecorded: Boolean(input.reason),
  })
  return policy
}

/**
 * Saves a consent text as the population's next version. A text identical to
 * the current one saves nothing: a version number should mean the words
 * changed. Older versions stay, readable, for the sheets that carried them.
 */
export async function saveConsentTemplate(
  tx: Prisma.TransactionClient,
  actorId: string,
  input: { population: ConsentPopulation; title: string; body: string; reason: string },
): Promise<ConsentTemplateVersionView> {
  const problems = consentTextProblems(input)
  if (problems.length > 0) throw new PreopDocumentsContractError("CONSENT_TEXT_INVALID", problems)
  const body = canonicalConsentText(input.body)
  const title = input.title.trim()
  const sha256 = consentTextSha256(body)
  // One writer at a time per population: two saves must not take one number.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`consent-template:${input.population}`}))`
  const current = await tx.consentTemplateVersion.findFirst({ where: { population: input.population as ClinicalMode }, orderBy: { version: "desc" } })
  if (current && current.sha256 === sha256 && current.title === title) {
    return { population: input.population, version: current.version, title: current.title, body: current.body, sha256: current.sha256 }
  }
  if (!current) {
    const bundled = bundledView(input.population)
    if (bundled.sha256 === sha256 && bundled.title === title) return bundled
  }
  const saved = await tx.consentTemplateVersion.create({
    data: { population: input.population as ClinicalMode, version: (current?.version ?? 0) + 1, title, body, sha256, createdById: actorId, changeReason: input.reason },
  })
  await logAuditInTransaction(tx, actorId, "CONSENT_TEMPLATE_SAVE", saved.id, {
    population: input.population,
    version: saved.version,
    sha256,
    reasonRecorded: Boolean(input.reason),
  })
  return { population: input.population, version: saved.version, title: saved.title, body: saved.body, sha256: saved.sha256 }
}

/** Every saved version of a population's text, newest first, with the bundled one last. */
export async function consentTemplateHistory(db: Db, population: ConsentPopulation) {
  const saved = await db.consentTemplateVersion.findMany({
    where: { population: population as ClinicalMode },
    orderBy: { version: "desc" },
    select: { version: true, title: true, sha256: true, createdAt: true, changeReason: true },
  })
  const bundled = bundledView(population)
  return [
    ...saved.map(row => ({ version: row.version, title: row.title, sha256: row.sha256, createdAt: row.createdAt.toISOString(), changeReason: row.changeReason })),
    { version: 0, title: bundled.title, sha256: bundled.sha256, createdAt: null, changeReason: null },
  ]
}
