/** Read-only verification of the published pediatric v2 DEV snapshot. */
import "dotenv/config"
import { isDeepStrictEqual } from "node:util"
import { clinicalRuleKey } from "../../lospor-core/src/clinical-rules"
import { createLosporPediatricV2Draft } from "../../lospor-core/src/platform-clinical-drafts"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")

const TARGET_PRESET_ID = "lospor-pediatrics-v2"
const canonical = createLosporPediatricV2Draft()
const canonicalByKey = new Map(canonical.rules.map(rule => [clinicalRuleKey(rule.payload), rule]))
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
} satisfies Prisma.PrismaClientOptions)

function comparable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

async function main() {
  // v1 used to be checked here as a published rollback snapshot. It has since
  // been pruned: it was cited by no recorded event, and it is reproducible from
  // source (create-platform-clinical-drafts + promote-pediatric-platform-ruleset),
  // so keeping a stale copy in the database was not what made rollback possible.
  const [preset, selection] = await Promise.all([
    prisma.clinicalPreset.findUnique({
      where: { id: TARGET_PRESET_ID },
      include: { rules: true },
    }),
    prisma.platformClinicalPresetSelection.findUnique({ where: { clinicalMode: "PEDIATRIC" } }),
  ])
  if (!preset) throw new Error(`${TARGET_PRESET_ID} is missing.`)
  if (preset.status !== "PUBLISHED"
    || preset.publishedAt === null
    || preset.version !== canonical.version
    || preset.scope !== "PLATFORM"
    || preset.rules.length !== canonical.rules.length) {
    throw new Error("Published pediatric v2 preset metadata differs from source.")
  }
  if (selection?.presetId !== TARGET_PRESET_ID) {
    throw new Error("Pediatric v2 is not the selected platform ruleset.")
  }

  const actualByKey = new Map(preset.rules.map(rule => [rule.ruleKey, rule]))
  for (const [ruleKey, expected] of canonicalByKey) {
    const actual = actualByKey.get(ruleKey)
    if (!actual
      || actual.ruleVersion !== `${canonical.key}.v${canonical.version}`
      || !isDeepStrictEqual(comparable(actual.payload), comparable(expected.payload))
      || !isDeepStrictEqual(comparable(actual.sourceRefs), comparable(expected.sourceRefs))) {
      throw new Error(`Published rule ${ruleKey} differs from source.`)
    }
  }

  console.log(JSON.stringify({
    selectedPresetId: selection.presetId,
    version: preset.version,
    status: preset.status,
    ruleCount: preset.rules.length,
    name: preset.name,
    exactSourceMatch: true,
  }, null, 2))
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
