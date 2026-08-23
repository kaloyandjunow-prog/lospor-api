/**
 * Actor resolution for the hand-run clinical-rules maintenance scripts.
 *
 * These scripts are the product owner's own shipping tooling. Nothing on a
 * hospital appliance invokes them: no install, update, seed or deploy path
 * calls them, and the bundled baselines that ship to hospitals are installed by
 * bundled-baseline-provisioner.ts instead.
 *
 * The rule they follow:
 *
 *   1. The audit row is always written. A maintenance run never silently
 *      mutates clinical content.
 *   2. A named administrator is required only when the target database is
 *      protected. Production is where "who did this" has to be a person.
 *   3. Otherwise the run is attributed to the same immutable, non-login release
 *      principal that authors the bundled baselines, so a laptop run is still
 *      attributable to the release it was made from.
 *   4. A supplied PUBLISHING_ADMIN_EMAIL is always honoured and always
 *      validated, protected database or not. Naming an administrator is a
 *      deliberate act; it is never downgraded to the release principal, and an
 *      address that does not resolve to an active ADMIN always aborts the run.
 *
 * Requiring the administrator everywhere was ceremony that could not be
 * satisfied: a freshly seeded development database contains no ADMIN account at
 * all, so the scripts could not run on a clean machine.
 *
 * Every function here mutates only through the caller's transaction client. It
 * opens no transaction of its own, so its atomicity is the caller's.
 */
import type { Prisma } from "@/generated/prisma/client"
import type { AuditActionCode } from "@/lib/audit-actions"
import { LOSPOR_BUNDLED_BASELINE_RELEASE } from "./bundled-baseline-contract"

const RELEASE_PRINCIPAL = LOSPOR_BUNDLED_BASELINE_RELEASE.technicalPrincipal

export type MaintenanceActorKind = "ADMIN" | "RELEASE"

export type MaintenanceActor = Readonly<{
  id: string
  kind: MaintenanceActorKind
}>

const PROTECTED_DATABASE_REQUIREMENT =
  "PUBLISHING_ADMIN_EMAIL is required against a protected database. Name the active "
  + "platform administrator accountable for this change; the release principal cannot "
  + "vouch for a maintenance run against production clinical data."

function namedAdminEmail(): string | null {
  const email = (process.env.PUBLISHING_ADMIN_EMAIL ?? "").trim()
  return email === "" ? null : email
}

/**
 * The same rule, checked before a script opens a connection, so a run that
 * cannot possibly be attributed fails before it does any work.
 */
export function assertMaintenanceActorConfigured(
  options: { protectedDatabase: boolean },
): void {
  if (options.protectedDatabase && namedAdminEmail() === null) {
    throw new Error(PROTECTED_DATABASE_REQUIREMENT)
  }
}

/**
 * The named administrator, or null for a release-principal run.
 *
 * A principal id must never occupy a User foreign key. AuditLog.userId is
 * deliberately not a foreign key and can carry either.
 */
export function actorUserId(actor: MaintenanceActor): string | null {
  return actor.kind === "ADMIN" ? actor.id : null
}

/** The release principal, or null when a person is accountable for the run. */
export function actorTechnicalPrincipalId(actor: MaintenanceActor): string | null {
  return actor.kind === "RELEASE" ? actor.id : null
}

/**
 * Idempotent: the release principal is one immutable identity, and a second
 * maintenance run must find the row it already wrote rather than a second
 * principal. An id that exists with different identity fields is a collision,
 * not something to overwrite.
 *
 * Writing this row means the database is no longer pristine for
 * provisionBundledClinicalBaselines, which installs the bundled pair only into
 * an untouched database. That is a development-machine ordering constraint: an
 * appliance provisions the baselines at install and never runs these scripts.
 */
async function ensureReleasePrincipal(tx: Prisma.TransactionClient): Promise<MaintenanceActor> {
  const stored = await tx.technicalPrincipal.upsert({
    where: { id: RELEASE_PRINCIPAL.id },
    create: {
      id: RELEASE_PRINCIPAL.id,
      kind: RELEASE_PRINCIPAL.kind,
      displayName: RELEASE_PRINCIPAL.displayName,
      releaseVersion: LOSPOR_BUNDLED_BASELINE_RELEASE.releaseVersion,
    },
    update: {},
    select: { id: true, kind: true, displayName: true, releaseVersion: true },
  })
  if (stored.kind !== RELEASE_PRINCIPAL.kind
    || stored.displayName !== RELEASE_PRINCIPAL.displayName
    || stored.releaseVersion !== LOSPOR_BUNDLED_BASELINE_RELEASE.releaseVersion) {
    throw new Error(
      `${RELEASE_PRINCIPAL.id} exists with a different identity than the LOSPOR `
      + `${LOSPOR_BUNDLED_BASELINE_RELEASE.releaseVersion} release principal`,
    )
  }
  return { id: stored.id, kind: "RELEASE" }
}

async function resolveNamedAdmin(
  tx: Prisma.TransactionClient,
  email: string,
): Promise<MaintenanceActor> {
  const admin = await tx.user.findUnique({
    where: { email },
    select: { id: true, role: true, deletedAt: true },
  })
  if (!admin || admin.role !== "ADMIN" || admin.deletedAt) {
    throw new Error("PUBLISHING_ADMIN_EMAIL must identify an active platform administrator")
  }
  return { id: admin.id, kind: "ADMIN" }
}

/**
 * Resolves who a maintenance run is attributed to. Call it inside the same
 * transaction as the change it will describe, so the actor cannot be deleted or
 * demoted between the check and the write.
 *
 * `dryRun` runs every check and writes nothing: a script whose dry run reports
 * what it would do must not leave the release-principal row behind as its only
 * effect. The administrator, when one is named, is still resolved and
 * validated, because that is one of the things a dry run is for.
 */
export async function resolveMaintenanceActor(
  tx: Prisma.TransactionClient,
  options: { protectedDatabase: boolean; dryRun?: boolean },
): Promise<MaintenanceActor> {
  assertMaintenanceActorConfigured(options)
  const email = namedAdminEmail()
  if (email !== null) return resolveNamedAdmin(tx, email)
  if (options.dryRun) return { id: RELEASE_PRINCIPAL.id, kind: "RELEASE" }
  return ensureReleasePrincipal(tx)
}

/**
 * Writes the durable row for a maintenance run inside the caller's
 * transaction. Every row carries the script that produced it and the kind of
 * actor behind it, so a reader can tell a person from the release at a glance
 * without resolving the id first.
 */
export async function writeMaintenanceAuditRow(
  tx: Prisma.TransactionClient,
  actor: MaintenanceActor,
  row: {
    action: AuditActionCode
    entityId: string
    source: string
    detail?: Readonly<Record<string, unknown>>
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: actor.id,
      action: row.action,
      entityId: row.entityId,
      detail: {
        ...row.detail,
        actorKind: actor.kind,
        source: row.source,
      } as unknown as Prisma.InputJsonValue,
    },
  })
}
