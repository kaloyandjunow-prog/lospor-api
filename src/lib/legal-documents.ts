import "server-only"
import { createHash } from "node:crypto"
import { z } from "zod"
import {
  requiredLegalDocuments,
  validateLegalAcceptances,
  LegalDocumentConfigurationError,
  type LegalAcceptanceReference,
  type LegalDocumentDescriptor,
  type LegalDocumentManifest,
} from "@lospor/core/legal"
import type { PreferredLocale } from "@lospor/core/account"
import type { Prisma } from "@/generated/prisma/client"

const configuredDocumentSchema = z.object({
  deployment: z.string().min(1),
  kind: z.enum(["TERMS", "PRIVACY"]),
  version: z.string().min(1),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  locale: z.enum(["bg", "en"]),
  content: z.string().min(1),
  // Optional in configuration because the server computes it. If supplied it
  // is checked, never trusted or copied blindly.
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict()

const configuredManifestSchema = z.object({
  deployment: z.string().min(1),
  documents: z.array(configuredDocumentSchema).min(4),
}).strict()

let cachedSource: string | null = null
let cachedManifest: LegalDocumentManifest | null = null

export class LegalConfigurationError extends Error {
  readonly code = "LEGAL_DOCUMENTS_UNAVAILABLE"
  readonly status = 503
}

export class LegalAcceptanceError extends Error {
  readonly code = "LEGAL_ACCEPTANCE_MISMATCH"
  readonly status = 422
  constructor(readonly details: unknown) {
    super("The accepted legal documents do not match the active deployment documents")
  }
}

export function contentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

function parseManifest(source: string): LegalDocumentManifest {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    throw new LegalConfigurationError("LOSPOR_LEGAL_DOCUMENTS_JSON is not valid JSON")
  }

  const parsed = configuredManifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new LegalConfigurationError(
      `LOSPOR_LEGAL_DOCUMENTS_JSON is invalid: ${parsed.error.issues[0]?.message ?? "invalid manifest"}`,
    )
  }

  const documents: LegalDocumentDescriptor[] = parsed.data.documents.map(document => {
    if (document.deployment !== parsed.data.deployment) {
      throw new LegalConfigurationError(
        `Legal document deployment ${document.deployment} does not match ${parsed.data.deployment}`,
      )
    }
    // Reject dates PostgreSQL/JavaScript would normalize (for example 2026-02-31).
    const effective = new Date(`${document.effectiveDate}T00:00:00.000Z`)
    if (Number.isNaN(effective.getTime()) || effective.toISOString().slice(0, 10) !== document.effectiveDate) {
      throw new LegalConfigurationError(`Invalid legal effectiveDate ${document.effectiveDate}`)
    }
    const computed = contentSha256(document.content)
    if (document.contentSha256 && document.contentSha256 !== computed) {
      throw new LegalConfigurationError(
        `Configured ${document.kind}/${document.locale} contentSha256 does not match its content`,
      )
    }
    return { ...document, contentSha256: computed }
  })

  const manifest = { deployment: parsed.data.deployment, documents }
  // Validate both language sets at startup/load time. This is the no-fallback
  // guarantee: one missing translation makes the deployment unhealthy instead
  // of quietly changing what a person accepted.
  try {
    requiredLegalDocuments(manifest, "bg")
    requiredLegalDocuments(manifest, "en")
  } catch (error) {
    if (error instanceof LegalDocumentConfigurationError) {
      throw new LegalConfigurationError(error.message)
    }
    throw error
  }
  return manifest
}

export function activeLegalManifest(): LegalDocumentManifest {
  const source = process.env.LOSPOR_LEGAL_DOCUMENTS_JSON?.trim()
  if (!source) {
    throw new LegalConfigurationError(
      "LOSPOR_LEGAL_DOCUMENTS_JSON must define exact TERMS and PRIVACY content in bg and en",
    )
  }
  if (source !== cachedSource || !cachedManifest) {
    cachedManifest = parseManifest(source)
    cachedSource = source
  }
  return cachedManifest
}

export function activeLegalDocuments(locale: PreferredLocale): LegalDocumentDescriptor[] {
  try {
    return requiredLegalDocuments(activeLegalManifest(), locale)
  } catch (error) {
    if (error instanceof LegalDocumentConfigurationError) {
      throw new LegalConfigurationError(error.message)
    }
    throw error
  }
}

export function validateActiveLegalAcceptances(
  acceptances: LegalAcceptanceReference[],
): LegalDocumentDescriptor[] {
  const locales = [...new Set(acceptances.map(acceptance => acceptance.locale))]
  if (locales.length !== 1 || (locales[0] !== "bg" && locales[0] !== "en")) {
    throw new LegalAcceptanceError({ reason: "ONE_LOCALE_REQUIRED" })
  }
  const documents = activeLegalDocuments(locales[0])
  const result = validateLegalAcceptances(documents, acceptances)
  if (!result.ok) throw new LegalAcceptanceError(result)
  return documents
}

export function legalAcceptanceCreateMany(
  userId: string,
  acceptances: LegalAcceptanceReference[],
): Prisma.LegalAcceptanceCreateManyInput[] {
  validateActiveLegalAcceptances(acceptances)
  const acceptedAt = new Date()
  return acceptances.map(acceptance => ({
    userId,
    deployment: acceptance.deployment,
    kind: acceptance.kind,
    documentVersion: acceptance.version,
    documentEffectiveAt: new Date(`${acceptance.effectiveDate}T00:00:00.000Z`),
    locale: acceptance.locale.toUpperCase() as "BG" | "EN",
    contentSha256: acceptance.contentSha256,
    acceptedAt,
  }))
}

/** Privacy-safe immutable descriptors for the durable legal audit event. */
export function legalAcceptanceAuditDetail(
  records: ReadonlyArray<Pick<
    Prisma.LegalAcceptanceCreateManyInput,
    | "deployment"
    | "kind"
    | "documentVersion"
    | "documentEffectiveAt"
    | "locale"
    | "contentSha256"
  >>,
) {
  return {
    documents: records.map(record => ({
      deployment: record.deployment,
      kind: record.kind,
      version: record.documentVersion,
      effectiveDate: record.documentEffectiveAt instanceof Date
        ? record.documentEffectiveAt.toISOString().slice(0, 10)
        : String(record.documentEffectiveAt).slice(0, 10),
      locale: String(record.locale).toLowerCase(),
      contentSha256: record.contentSha256,
    })),
  }
}

export function mapLegalAcceptance(record: {
  deployment: string
  kind: "TERMS" | "PRIVACY"
  documentVersion: string
  documentEffectiveAt: Date
  locale: "BG" | "EN"
  contentSha256: string
  acceptedAt: Date
}) {
  return {
    deployment: record.deployment,
    kind: record.kind,
    version: record.documentVersion,
    effectiveDate: record.documentEffectiveAt.toISOString().slice(0, 10),
    locale: record.locale.toLowerCase() as PreferredLocale,
    contentSha256: record.contentSha256,
    acceptedAt: record.acceptedAt.toISOString(),
  }
}

export function resetLegalManifestCacheForTests(): void {
  cachedSource = null
  cachedManifest = null
}
