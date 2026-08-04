import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const importer = readFileSync(
  join(process.cwd(), "scripts/create-platform-clinical-drafts.ts"),
  "utf8",
)
const pediatricFluidAppender = readFileSync(
  join(process.cwd(), "scripts/append-pediatric-fluid-profiles-to-draft.ts"),
  "utf8",
)
const pediatricPlatformPromoter = readFileSync(
  join(process.cwd(), "scripts/promote-pediatric-platform-ruleset.ts"),
  "utf8",
)
const verifier = readFileSync(
  join(process.cwd(), "scripts/verify-platform-clinical-drafts.ts"),
  "utf8",
)

describe("platform clinical draft importer", () => {
  it("requires explicit non-production authorization", () => {
    expect(importer).toContain("CREATE_PLATFORM_CLINICAL_DRAFTS")
    expect(importer).toContain('process.env.VERCEL_ENV === "production"')
    expect(importer).toContain('process.env.NODE_ENV === "production"')
  })

  it("is append-only and leaves drafts inactive", () => {
    expect(importer).toContain('status: "DRAFT"')
    expect(importer).toContain("publishedAt: null")
    expect(importer).toContain("clinicalPreset.create")
    expect(importer).not.toMatch(/\.delete(?:Many)?\s*\(/)
    expect(importer).not.toMatch(/\.update(?:Many)?\s*\(/)
    expect(importer).not.toMatch(/\.upsert\s*\(/)
    expect(importer).not.toContain("platformClinicalPresetSelection.create")
  })

  it("aborts instead of replacing an existing identity", () => {
    expect(importer).toContain("Refusing to overwrite existing rulesets")
    expect(importer).toContain("findMany")
  })

  it("guards the one-time pediatric fluid append by exact draft identity and dry-run", () => {
    expect(pediatricFluidAppender).toContain("APPEND_PEDIATRIC_FLUID_PROFILES_TO_DRAFT")
    expect(pediatricFluidAppender).toContain('TARGET_CLINICAL_PRESET_ID="lospor-pediatrics-v1"')
    expect(pediatricFluidAppender).toContain('const APPLY_ARGUMENT = "--apply"')
    expect(pediatricFluidAppender).toContain('process.env.VERCEL_ENV === "production"')
    expect(pediatricFluidAppender).toContain('process.env.NODE_ENV === "production"')
    expect(pediatricFluidAppender).toContain('preset.scope !== "PLATFORM"')
    expect(pediatricFluidAppender).toContain('preset.status !== "DRAFT"')
    expect(pediatricFluidAppender).toContain("preset.publishedAt !== null")
    expect(pediatricFluidAppender).toContain("Refusing to append to a selected pediatric ruleset")
    expect(pediatricFluidAppender).toContain("Refusing to overwrite existing pediatric fluid rules")
    expect(pediatricFluidAppender).toContain("reviewed 184-rule baseline")
  })

  it("only appends clinical rule rows and cannot publish, select, replace or delete", () => {
    expect(pediatricFluidAppender).toContain("clinicalPresetRule.create")
    expect(pediatricFluidAppender).not.toContain("clinicalPreset.create")
    expect(pediatricFluidAppender).not.toMatch(/\.delete(?:Many)?\s*\(/)
    expect(pediatricFluidAppender).not.toMatch(/\.update(?:Many)?\s*\(/)
    expect(pediatricFluidAppender).not.toMatch(/\.upsert\s*\(/)
    expect(pediatricFluidAppender).not.toContain("platformClinicalPresetSelection.create")
    expect(pediatricFluidAppender).not.toContain("institutionClinicalPresetSelection.create")
    expect(pediatricFluidAppender).not.toContain("userClinicalPresetSelection.create")
  })

  it("verifies imported drafts against source-generated keys, payloads and source references", () => {
    expect(verifier).toContain("createLosporPediatricPlatformDraft()")
    expect(verifier).toContain("createLosporAdultV2Draft()")
    expect(verifier).toContain("clinicalRuleKey(sourceRule.payload)")
    expect(verifier).toContain("sameJson(actual.payload, sourceRule.payload)")
    expect(verifier).toContain("sameJson(actual.sourceRefs, sourceRule.sourceRefs)")
    expect(verifier).not.toContain("ruleCount: 184")
  })

  it("guards pediatric platform promotion by exact source, actor and selection state", () => {
    expect(pediatricPlatformPromoter).toContain("PROMOTE_PEDIATRIC_PLATFORM_RULESET")
    expect(pediatricPlatformPromoter).toContain('TARGET_CLINICAL_PRESET_ID="lospor-pediatrics-v1"')
    expect(pediatricPlatformPromoter).toContain('const APPLY_ARGUMENT = "--apply"')
    expect(pediatricPlatformPromoter).toContain('process.env.VERCEL_ENV === "production"')
    expect(pediatricPlatformPromoter).toContain('process.env.NODE_ENV === "production"')
    expect(pediatricPlatformPromoter).toContain('admin.role !== "ADMIN"')
    expect(pediatricPlatformPromoter).toContain('preset.status !== "DRAFT"')
    expect(pediatricPlatformPromoter).toContain("validateClinicalRuleCollectionForPublication")
    expect(pediatricPlatformPromoter).toContain("isDeepStrictEqual")
    expect(pediatricPlatformPromoter).toContain("platformClinicalPresetSelection.create")
    expect(pediatricPlatformPromoter).toContain("Prisma.TransactionIsolationLevel.Serializable")
  })
})
