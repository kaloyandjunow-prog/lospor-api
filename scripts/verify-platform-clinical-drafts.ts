/**
 * Verifies that the source-controlled platform drafts were imported intact and
 * remain inactive. This script is read-only.
 */
import "dotenv/config"
import {
  clinicalRuleKey,
  isLegacyEquipmentRuleKind,
} from "@lospor/core/clinical-rules"
import {
  createLosporAdultV2Draft,
  createLosporPediatricPlatformDraft,
  type PlatformClinicalDraft,
} from "@lospor/core/platform-clinical-drafts"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const SOURCE_DRAFTS = [
  createLosporPediatricPlatformDraft(),
  createLosporAdultV2Draft(),
] as const
const EXPECTED_DRAFTS = new Map<string, PlatformClinicalDraft>(
  SOURCE_DRAFTS.map(draft => [draft.id, draft]),
)

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
} satisfies Prisma.PrismaClientOptions)

function payloadKind(payload: Prisma.JsonValue): string {
  return payload !== null
    && typeof payload === "object"
    && !Array.isArray(payload)
    && typeof payload.kind === "string"
    ? payload.kind
    : "UNKNOWN"
}

function legacyRuleKey(ruleKey: string): boolean {
  return isLegacyEquipmentRuleKind(ruleKey.split(":", 1)[0])
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalJson(item))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  )
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
}

async function main() {
  const ids = [...EXPECTED_DRAFTS.keys()]
  const presets = await prisma.clinicalPreset.findMany({
    where: { id: { in: ids } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      key: true,
      clinicalMode: true,
      scope: true,
      version: true,
      status: true,
      publishedAt: true,
      rules: {
        select: {
          ruleKey: true,
          ruleVersion: true,
          payload: true,
          sourceRefs: true,
        },
      },
    },
  })

  if (presets.length !== ids.length) {
    throw new Error(`Expected ${ids.length} drafts, found ${presets.length}`)
  }

  const summaries = presets.map(preset => {
    const expected = EXPECTED_DRAFTS.get(preset.id)
    if (!expected) throw new Error(`Unexpected draft ${preset.id}`)
    if (preset.key !== expected.key
      || preset.clinicalMode !== expected.clinicalMode
      || preset.version !== expected.version
      || preset.rules.length !== expected.rules.length
      || preset.scope !== "PLATFORM"
      || preset.status !== "DRAFT"
      || preset.publishedAt !== null) {
      throw new Error(`Draft ${preset.id} does not match its inactive source definition`)
    }

    const actualByKey = new Map(preset.rules.map(rule => [rule.ruleKey, rule]))
    for (const sourceRule of expected.rules) {
      const ruleKey = clinicalRuleKey(sourceRule.payload)
      const actual = actualByKey.get(ruleKey)
      if (!actual) throw new Error(`Draft ${preset.id} is missing ${ruleKey}`)
      const expectedVersion = `${expected.key}.v${expected.version}.draft1`
      if (actual.ruleVersion !== expectedVersion
        || !sameJson(actual.payload, sourceRule.payload)
        || !sameJson(actual.sourceRefs, sourceRule.sourceRefs)) {
        throw new Error(`Draft ${preset.id} rule ${ruleKey} differs from its source definition`)
      }
    }

    const kinds = preset.rules.reduce<Record<string, number>>((counts, rule) => {
      const kind = payloadKind(rule.payload)
      counts[kind] = (counts[kind] ?? 0) + 1
      return counts
    }, {})
    return {
      id: preset.id,
      key: preset.key,
      mode: preset.clinicalMode,
      scope: preset.scope,
      version: preset.version,
      status: preset.status,
      publishedAt: preset.publishedAt,
      ruleCount: expected.rules.length,
      kinds,
    }
  })

  const [platform, institution, user, storedRules, storedOverrides, storedReviews] = await Promise.all([
    prisma.platformClinicalPresetSelection.count({ where: { presetId: { in: ids } } }),
    prisma.institutionClinicalPresetSelection.count({ where: { presetId: { in: ids } } }),
    prisma.userClinicalPresetSelection.count({ where: { presetId: { in: ids } } }),
    prisma.clinicalPresetRule.findMany({ select: { ruleKey: true, payload: true } }),
    prisma.institutionClinicalRuleOverride.findMany({ select: { ruleKey: true, payload: true } }),
    prisma.clinicalRuleReview.findMany({ select: { ruleKey: true } }),
  ])
  if (platform !== 0 || institution !== 0 || user !== 0) {
    throw new Error("An imported draft is unexpectedly selected")
  }

  const legacyEquipment = {
    rules: storedRules.filter(rule =>
      legacyRuleKey(rule.ruleKey) || isLegacyEquipmentRuleKind(payloadKind(rule.payload)),
    ).length,
    overrides: storedOverrides.filter(rule =>
      legacyRuleKey(rule.ruleKey) || isLegacyEquipmentRuleKind(payloadKind(rule.payload)),
    ).length,
    reviews: storedReviews.filter(review => legacyRuleKey(review.ruleKey)).length,
  }
  if (Object.values(legacyEquipment).some(count => count !== 0)) {
    throw new Error(`Legacy editable equipment rows remain: ${JSON.stringify(legacyEquipment)}`)
  }

  console.log(JSON.stringify({
    presets: summaries,
    selections: { platform, institution, user },
    legacyEquipment,
  }, null, 2))
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
