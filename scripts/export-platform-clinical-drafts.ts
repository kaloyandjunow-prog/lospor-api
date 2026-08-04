import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { clinicalRuleKey } from "@lospor/core/clinical-rules"
import {
  createLosporAdultV2Draft,
  createLosporPediatricPlatformDraft,
  createLosporPediatricV2Draft,
  type PlatformClinicalDraft,
} from "@lospor/core/platform-clinical-drafts"

const outputDirectory = resolve(process.cwd(), "../lospor-docs/static/downloads")

function exportShape(draft: PlatformClinicalDraft) {
  return {
    schemaVersion: 1,
    generatedFrom: "@lospor/core/platform-clinical-drafts",
    ...draft,
    rules: draft.rules.map(rule => ({
      ruleKey: clinicalRuleKey(rule.payload),
      payload: rule.payload,
      sourceRefs: rule.sourceRefs,
    })),
  }
}

async function main() {
  await mkdir(outputDirectory, { recursive: true })
  const exports = [
    ["lospor-pediatric-ruleset-v1-draft.json", createLosporPediatricPlatformDraft()],
    ["lospor-pediatric-ruleset-v2-draft.json", createLosporPediatricV2Draft()],
    ["lospor-adult-ruleset-v2-draft.json", createLosporAdultV2Draft()],
  ] as const
  for (const [fileName, draft] of exports) {
    await writeFile(
      resolve(outputDirectory, fileName),
      `${JSON.stringify(exportShape(draft), null, 2)}\n`,
      "utf8",
    )
    console.log(`Exported ${fileName} (${draft.rules.length} rules)`)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
