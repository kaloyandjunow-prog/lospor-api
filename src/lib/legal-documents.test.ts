import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  LegalAcceptanceError,
  LegalConfigurationError,
  activeLegalDocuments,
  contentSha256,
  resetLegalManifestCacheForTests,
  validateActiveLegalAcceptances,
} from "./legal-documents"

function manifest() {
  return {
    deployment: "public-demo",
    documents: (["bg", "en"] as const).flatMap(locale =>
      (["TERMS", "PRIVACY"] as const).map(kind => ({
        deployment: "public-demo",
        kind,
        version: kind === "TERMS" ? "5.0" : "3.0",
        effectiveDate: "2026-09-01",
        locale,
        content: `${locale}:${kind}:exact content`,
        contentSha256: undefined as string | undefined,
      }))),
  }
}

function configure(value = manifest()) {
  process.env.LOSPOR_LEGAL_DOCUMENTS_JSON = JSON.stringify(value)
  resetLegalManifestCacheForTests()
}

afterEach(() => {
  delete process.env.LOSPOR_LEGAL_DOCUMENTS_JSON
  resetLegalManifestCacheForTests()
})

describe("active legal documents", () => {
  it("computes hashes from exact server content", () => {
    configure()
    const documents = activeLegalDocuments("bg")
    expect(documents).toHaveLength(2)
    expect(documents[0].contentSha256).toBe(contentSha256(documents[0].content))
  })

  it("fails configuration when one locale is incomplete instead of falling back", () => {
    const incomplete = manifest()
    incomplete.documents = incomplete.documents.filter(document =>
      !(document.locale === "bg" && document.kind === "PRIVACY"))
    configure(incomplete)
    expect(() => activeLegalDocuments("bg")).toThrowError(LegalConfigurationError)
  })

  it("reports duplicate active documents as deployment configuration failure", () => {
    const duplicate = manifest()
    duplicate.documents.push({ ...duplicate.documents[0] })
    configure(duplicate)
    expect(() => activeLegalDocuments("bg")).toThrowError(LegalConfigurationError)
  })

  it("rejects a client-substituted hash and requires both kinds", () => {
    configure()
    const references = activeLegalDocuments("en").map(({ content: _content, ...reference }) => reference)
    expect(() => validateActiveLegalAcceptances([
      { ...references[0], contentSha256: "0".repeat(64) },
      references[1],
    ])).toThrowError(LegalAcceptanceError)
    expect(() => validateActiveLegalAcceptances([references[0]])).toThrowError(LegalAcceptanceError)
  })

  it("rejects a configured hash that does not match configured content", () => {
    const configured = manifest()
    configured.documents[0] = { ...configured.documents[0], contentSha256: "0".repeat(64) }
    configure(configured)
    expect(() => activeLegalDocuments("bg")).toThrowError(LegalConfigurationError)
  })
})
