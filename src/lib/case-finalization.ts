import { logAuditInTransaction } from "@/lib/audit"
import { writeSnapshotAsync } from "@/lib/case-audit"
import { syncCaseRelational } from "@/lib/relational-sync"
import {
  evaluateCaseFinalization,
  type ClinicalIssue,
} from "@lospor/core/clinical-validation"
import type { PrismaClient, Prisma } from "@/generated/prisma/client"

type Db = PrismaClient | Prisma.TransactionClient

/**
 * The actor recorded for a case closed automatically by the pending-close
 * sweep, not by a person pressing a button.
 *
 * `AuditLog.userId` and `CaseFinalization.finalizedById` are both
 * deliberately plain strings, not foreign keys to User (see their schema
 * comments) -- specifically so a row can name an actor that outlives, or was
 * never, a real account. The admin audit viewer already falls back to
 * `{ name: l.userId }` for any id it cannot resolve to a User or a
 * TechnicalPrincipal, so this string is what a reader sees verbatim as "who
 * did this", with no further wiring required.
 *
 * Previously this recorded the case's assignee as the actor on an automatic
 * close, with only the audit action name (CASE_AUTO_FINALIZED) to say a timer
 * did it rather than them -- legally and audit-wise ambiguous, since the
 * assignee's name reads the same whether they pressed Finalize or were never
 * in the building when the window ran out. The assignee is still recorded,
 * as `assignedUserId` in the audit detail, alongside the honest actor.
 */
export const AUTO_CLOSE_SYSTEM_ACTOR_ID = "System (automatic closure)"

/**
 * Closing a case, for both the clinician who presses the button and the sweep
 * that closes one whose review window ran out.
 *
 * Extracted from the finalize route so the two cannot drift. Everything that
 * makes finalization an attestation -- the readiness gate, the relational
 * reconcile, the immutable snapshot and the audit row, all inside one
 * transaction -- happens here once. The route keeps what is genuinely its own:
 * authentication, the assignee check, the pediatric client-version gate, and
 * turning a refusal into an HTTP body.
 */

export type FinalizeOutcome =
  | { ok: true; from: string; finalizedAt: Date }
  | { ok: false; blockers: ClinicalIssue[] }

export class CaseFinalizationStepError extends Error {
  constructor(readonly step: "relational-sync" | "snapshot", readonly cause: unknown) {
    super(`CASE_FINALIZATION_${step === "snapshot" ? "SNAPSHOT" : "RELATIONAL_SYNC"}_FAILED`)
  }
}

/**
 * Whether a case is complete enough to close, read the way finalization reads
 * it.
 *
 * Exported so the review route asks this exact question rather than its own
 * approximation of it. It previously asked `evaluatePostopReadiness`, which
 * looks only at the Aldrete components and the disposition -- so a case with
 * an empty preoperative assessment and no intraoperative record at all could
 * enter AWAITING_REVIEW, start the thirty-minute closure countdown, and then
 * be refused by the very check the countdown exists to run. The comment there
 * claimed the two were the same check. They were not, and the only way to
 * keep that claim honest is for there to be one.
 *
 * The whole preoperative record is read deliberately: selecting the fields the
 * validator happens to consult today would drift the moment core changes what
 * "complete" means.
 */
export async function evaluateCaseReadiness(tx: Db, caseId: string) {
  const preop = await tx.preoperativeAssessment.findUnique({ where: { caseId } })
  const intraop = await tx.intraoperativeRecord.findUnique({
    where: { caseId },
    select: {
      id: true,
      startedAt: true,
      endedAt: true,
      startTime: true,
      endTime: true,
      techniques: true,
    },
  })
  const postop = await tx.postoperativeRecord.findUnique({
    where: { caseId },
    select: {
      aldreteActivity: true,
      aldreteRespiration: true,
      aldreteCirculation: true,
      aldreteConsciousness: true,
      aldreteSpO2: true,
      disposition: true,
    },
  })
  return evaluateCaseFinalization({ preop, intraop, postop })
}

/**
 * Runs inside a caller-held case lock. `actorUserId` is the case's assignee,
 * always -- for a manual finalize it is also who signs the attestation, but
 * for an automatic close (`options.automatic`) the actor recorded against
 * the audit row and the finalization snapshot is `AUTO_CLOSE_SYSTEM_ACTOR_ID`
 * instead: a timer closing a case because nobody touched it for thirty
 * minutes is not the same fact as that person actively attesting to it, and
 * the audit trail should not read as if it were. `actorUserId` is still kept,
 * as `assignedUserId` in the audit detail, so who was responsible at the time
 * is never lost.
 */
export async function finalizeCaseWithinTransaction(
  tx: Db,
  caseId: string,
  actorUserId: string,
  options: { currentStatus: string; automatic?: boolean },
): Promise<FinalizeOutcome> {
  const signedBy = options.automatic ? AUTO_CLOSE_SYSTEM_ACTOR_ID : actorUserId
  const readiness = await evaluateCaseReadiness(tx, caseId)
  if (!readiness.valid) {
    return { ok: false, blockers: readiness.issues.filter(issue => issue.severity === "error") }
  }

  try {
    await syncCaseRelational(tx, caseId)
  } catch (error) {
    throw new CaseFinalizationStepError("relational-sync", error)
  }

  const finalizedAt = new Date()
  await tx.case.update({
    where: { id: caseId },
    data: { status: "COMPLETE", finalizedAt },
  })

  try {
    // After the COMPLETE transition, so the snapshot holds the exact lifecycle
    // state and revisions this transaction commits.
    await writeSnapshotAsync(tx, caseId, signedBy)
  } catch (error) {
    throw new CaseFinalizationStepError("snapshot", error)
  }

  // In the transaction, not after the response. Finalization is an attestation;
  // a commit with no record of who made it is the failure this prevents.
  await logAuditInTransaction(
    tx,
    signedBy,
    options.automatic ? "CASE_AUTO_FINALIZED" : "CASE_FINALIZED",
    caseId,
    {
      from: options.currentStatus,
      to: "COMPLETE",
      ...(options.automatic ? { assignedUserId: actorUserId } : {}),
    },
  )

  return { ok: true, from: options.currentStatus, finalizedAt }
}
