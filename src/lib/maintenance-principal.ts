import type { Prisma } from "@/generated/prisma/client"
import type { AuditActionCode } from "@/lib/audit-actions"
import { LOSPOR_BUNDLED_BASELINE_RELEASE } from "@/lib/clinical-rules/bundled-baseline-contract"

/**
 * Who a maintenance script is, in the audit trail.
 *
 * The alternative was to make each script take an administrator's email and
 * write that person's id into the audit row. That produces a trail which says a
 * named clinician created a ruleset at 03:00 on a release night when they did
 * not; the whole point of HAUD-01 is that the trail is true, and a false actor
 * is worse than an unfamiliar one because it cannot be told apart from a real
 * action by that person.
 *
 * So the actor is the release itself. This is not a new idea introduced here:
 * `TechnicalPrincipal` already exists for exactly this, and the bundled
 * clinical baselines are already published and selected under
 * `lospor-release:<version>` rather than under whoever ran the installer. These
 * scripts reuse that same principal, and each audit row additionally names the
 * script, so "which automated operation did this" is answerable without
 * inventing a person.
 *
 * `AuditLog.userId` is deliberately not a foreign key (see the model), so a
 * principal id can occupy it without the audit trail pretending the principal
 * is an account that could sign in. It cannot: there is no such User row, and
 * there must never be one.
 *
 * The boundary is deliberately narrow. Every script below imports or prunes
 * exactly the source-controlled content of this release, so "the release did
 * it" is true of each. `scripts/seed-play-reviewer.ts` is not here and must not
 * be added: it provisions and resets a live production account at whatever
 * moment an operator chooses, which the release did not do and cannot vouch
 * for. That one stays DECISION_BLOCKED until someone decides who is
 * accountable for it.
 */
export const MAINTENANCE_TECHNICAL_PRINCIPAL = LOSPOR_BUNDLED_BASELINE_RELEASE.technicalPrincipal

/** The scripts that write under the principal. Kept here so the inventory and the scripts cannot drift. */
export const MAINTENANCE_SCRIPTS = [
  "clinical-rules:create-platform-drafts",
  "clinical-rules:create-pediatric-v2-draft",
  "clinical-rules:append-pediatric-fluid-profiles",
  "clinical-rules:append-pediatric-infusion-profiles",
  "clinical-rules:prune",
] as const

export type MaintenanceScript = (typeof MAINTENANCE_SCRIPTS)[number]

type PrincipalWriter = Pick<Prisma.TransactionClient, "technicalPrincipal">
type AuditWriter = Pick<Prisma.TransactionClient, "auditLog">

/**
 * Resolves the release principal, creating it on first use.
 *
 * `update` deliberately rewrites the display name rather than leaving whatever
 * an earlier release wrote: the row is keyed by `(kind, releaseVersion)`, so a
 * mismatch there would mean two releases disagreeing about the name of the same
 * principal.
 */
export async function ensureMaintenancePrincipal(tx: PrincipalWriter): Promise<string> {
  const principal = MAINTENANCE_TECHNICAL_PRINCIPAL
  await tx.technicalPrincipal.upsert({
    where: { id: principal.id },
    create: {
      id: principal.id,
      kind: principal.kind,
      displayName: principal.displayName,
      releaseVersion: LOSPOR_BUNDLED_BASELINE_RELEASE.releaseVersion,
    },
    update: { displayName: principal.displayName },
  })
  return principal.id
}

/**
 * Writes one durable audit row attributed to the release principal.
 *
 * Must be called with the same transaction client as the mutation it describes.
 * A maintenance script that committed its change and then failed to write the
 * audit row would leave a ruleset nobody can account for.
 */
export async function recordMaintenanceAudit(tx: AuditWriter, input: {
  actorId: string
  action: AuditActionCode
  entityId: string
  script: MaintenanceScript
  detail?: Record<string, unknown>
}): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: input.actorId,
      action: input.action,
      entityId: input.entityId,
      detail: {
        ...input.detail,
        actorKind: "TECHNICAL_PRINCIPAL",
        principalId: input.actorId,
        script: input.script,
        releaseVersion: LOSPOR_BUNDLED_BASELINE_RELEASE.releaseVersion,
      } satisfies Prisma.InputJsonObject,
    },
  })
}
