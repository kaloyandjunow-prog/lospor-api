/**
 * Installs the 9.15.0 (v3) clinical baselines on a deployment whose v2
 * baselines were arranged by hand, and optionally selects them.
 *
 * The bundled provisioner refuses such a deployment, rightly: it cannot tell a
 * half-finished install from a deliberate arrangement, so it touches neither.
 * The public deployment is that case. This runs only the v3 step, the same code
 * an appliance runs, so the v3 rows are byte for byte the release's: same
 * preset ids, rules, fingerprints, release principal and publication evidence.
 * Nothing of v2 is read for writing, changed or removed.
 *
 * Selecting is a separate, named act. `--select` points the ADULT and PEDIATRIC
 * platform selections at v3, attributed to the administrator in
 * PUBLISHING_ADMIN_EMAIL, with the same CLINICAL_RULESET_SELECT audit row the
 * admin console writes. v2 stays published, so going back is one selection.
 *
 * Every run is a dry run unless `--apply` is given: the whole transaction runs,
 * prints what it did, and is rolled back.
 *
 *   $env:INSTALL_V3_BASELINES="YES"
 *   $env:PUBLISHING_ADMIN_EMAIL="admin@example.com"     # required for production
 *   $env:LOSPOR_ALLOW_PROTECTED_DB="<project-ref>"      # production only
 *   npm run clinical-rules:install-v3 -- --select            # dry run
 *   npm run clinical-rules:install-v3 -- --select --apply    # for real
 */
import "dotenv/config"
import { PrismaPg } from "@prisma/adapter-pg"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import type { AuditActionCode } from "../src/lib/audit-actions"
import {
  assertExactBundledBaselineArtifacts,
  computeBundledBaselineArtifacts,
} from "../src/lib/clinical-rules/bundled-baseline-contract"
import {
  assertExactBundledBaselineV3Artifacts,
  computeBundledBaselineV3Artifacts,
} from "../src/lib/clinical-rules/bundled-baseline-v3"
import { provisionBundledBaselineV3InTransaction } from "../src/lib/clinical-rules/bundled-baseline-v3-provisioner"
import {
  actorUserId,
  assertMaintenanceActorConfigured,
  resolveMaintenanceActor,
  writeMaintenanceAuditRow,
} from "../src/lib/clinical-rules/maintenance-actor"
import { assertDatabaseWritable } from "./lib/protected-database"

const ARGUMENTS = ["--apply", "--select"]
const args = process.argv.slice(2)
const unknown = args.filter(argument => !ARGUMENTS.includes(argument))
if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(", ")}`)
const apply = args.includes("--apply")
const select = args.includes("--select")

if (process.env.INSTALL_V3_BASELINES !== "YES") {
  throw new Error('Refusing to run. Set INSTALL_V3_BASELINES="YES" explicitly.')
}
const database = assertDatabaseWritable("install the v3 clinical baselines")
assertMaintenanceActorConfigured({ protectedDatabase: database.protected })
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")

class DryRunRollback extends Error {}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
} satisfies Prisma.PrismaClientOptions)

async function main() {
  const v2 = computeBundledBaselineArtifacts()
  assertExactBundledBaselineArtifacts(v2)
  const v3 = computeBundledBaselineV3Artifacts(v2)
  assertExactBundledBaselineV3Artifacts(v3)

  const report: string[] = []
  try {
    await prisma.$transaction(async tx => {
      const installed = await provisionBundledBaselineV3InTransaction(tx, v3, new Date())
      report.push(`v3 baselines: ${installed.outcome} (${installed.technicalPrincipalId})`)
      for (const baseline of installed.baselines) {
        report.push(`  ${baseline.clinicalMode}: ${baseline.presetId}, ${baseline.ruleCount} rules, ${baseline.contentSha256.slice(0, 12)}`)
      }
      if (select) await selectV3(tx, report)
      // Inside the transaction, so a dry run rolls back the install too.
      if (!apply) throw new DryRunRollback()
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 120_000,
    })
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error
  }
  console.log(report.join("\n"))
  console.log(apply ? "\nCommitted." : "\nDry run: everything above was rolled back. Re-run with --apply.")

  async function selectV3(tx: Prisma.TransactionClient, report: string[]) {
    const actor = await resolveMaintenanceActor(tx, { protectedDatabase: database.protected })
    const by = actorUserId(actor)
    for (const artifact of v3) {
      const mode = artifact.identity.clinicalMode
      const previous = await tx.platformClinicalPresetSelection.findUnique({
        where: { clinicalMode: mode },
        select: { presetId: true },
      })
      if (previous?.presetId === artifact.identity.presetId) {
        report.push(`  ${mode}: already selected`)
        continue
      }
      const evidence = await tx.clinicalRulesetPublicationEvidence.findUniqueOrThrow({
        where: { presetId: artifact.identity.presetId },
        select: { contentSha256: true, diffSha256: true },
      })
      await tx.platformClinicalPresetSelection.upsert({
        where: { clinicalMode: mode },
        create: { clinicalMode: mode, presetId: artifact.identity.presetId, selectedById: by },
        update: {
          presetId: artifact.identity.presetId,
          selectedById: by,
          selectedByTechnicalPrincipalId: by ? null : actor.id,
          selectedAt: new Date(),
        },
      })
      await writeMaintenanceAuditRow(tx, actor, {
        action: "CLINICAL_RULESET_SELECT" satisfies AuditActionCode,
        entityId: artifact.identity.presetId,
        source: "scripts/install-v3-platform-baselines.ts",
        detail: {
          scope: "PLATFORM",
          clinicalMode: mode,
          previousPresetId: previous?.presetId ?? null,
          contentSha256: evidence.contentSha256,
          diffSha256: evidence.diffSha256,
        },
      })
      report.push(`  ${mode}: selected ${artifact.identity.presetId} (was ${previous?.presetId ?? "none"})`)
    }
  }
}

main()
  .catch(error => { console.error(error); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
