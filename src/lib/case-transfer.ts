import type { Prisma, PrismaClient } from "@/generated/prisma/client"
import { generateCaseCode, isPrismaUniqueError, reserveCaseCode } from "@/lib/case-code"

export type TransferOutcome = {
  /** The code the case carried before the move, when it had to be renumbered. */
  previousCaseCode: string | null
  /** The code it carries now — unchanged unless the recipient already used it. */
  caseCode: string | null
  institutionId: string | null
}

/**
 * Move a case to another clinician.
 *
 * Two things make this more than a `userId` update:
 *
 * 1. **Case codes are per-user sequences that both start at 0001.** Any two
 *    clinicians who each opened a case this year both hold "2026-0001", so a
 *    plain reassignment trips `@@unique([userId, caseCode])` and 500s. When the
 *    recipient already holds the code, the case is renumbered into their
 *    sequence and the old code is recorded on the transfer row, so the paper
 *    record can still be reconciled with the database.
 * 2. **The institution does not move.** It used to: the case was rewritten to
 *    the recipient's institution, on the reasoning that leaving it behind put
 *    the wrong hospital on the printed record. That is true only if a transfer
 *    means "this was entered under the wrong account". Read as "responsibility
 *    has moved", it made the record, the printed protocol and the OMOP
 *    care_site all claim the operation had happened somewhere it had not, and
 *    it desynchronised patient identity at the Central boundary.
 *
 *    Cross-institution transfer is refused outright now, so this function
 *    only ever moves a case between clinicians at the same hospital and the
 *    institution is left exactly as recorded. The caller enforces that; the
 *    assertion below is here so a future caller cannot quietly reintroduce it.
 *
 * Everything runs in one transaction, including superseding any other pending
 * transfer, so a case can never end up half-moved.
 */
export async function transferCaseOwnershipInTransaction(
  tx: Prisma.TransactionClient,
  caseId: string,
  toUserId: string,
  opts: { supersedePending?: boolean; acceptTransferId?: string } = {},
): Promise<TransferOutcome> {
  const current = await tx.case.findUniqueOrThrow({
    where: { id: caseId },
    select: { caseCode: true, institutionId: true },
  })
  const recipient = await tx.user.findUniqueOrThrow({
    where: { id: toUserId },
    select: { institutionId: true },
  })

  let caseCode = current.caseCode
  let previousCaseCode: string | null = null
  if (caseCode) {
    const clash = await tx.case.findFirst({
      where: { userId: toUserId, caseCode, id: { not: caseId } },
      select: { id: true },
    })
    if (clash) {
      previousCaseCode = caseCode
      // Renumber inside the year the case already belongs to, not the year the
      // handover happens to be accepted in.
      //
      // A pre-assessment done in December and handed over in January would
      // otherwise be renumbered into the recipient's 2027 sequence for an
      // operation performed in 2026 — a year that is printed on the chart and
      // that anyone counting a year's work would then count it under. The
      // existing code carries the case's year, so it is the authority; a case
      // with no code yet has nothing to preserve and falls back to now.
      const year = Number(caseCode.slice(0, 4))
      caseCode = await generateCaseCode(
        toUserId,
        tx,
        Number.isFinite(year) && year > 1900 ? year : undefined,
      )
    }
  }

  // The recipient now holds this number, whether it was renumbered into their
  // sequence or arrived unchanged. Push their counter past it so it is never
  // issued a second time.
  if (caseCode) await reserveCaseCode(toUserId, tx, caseCode)

  if (opts.supersedePending) {
    await tx.caseTransfer.updateMany({
      where: { caseId, status: "PENDING" },
      data: { status: "DECLINED", resolvedAt: new Date() },
    })
  }
  if (opts.acceptTransferId) {
    await tx.caseTransfer.update({
      where: { id: opts.acceptTransferId },
      data: { status: "ACCEPTED", resolvedAt: new Date(), previousCaseCode },
    })
  }

  if (current.institutionId !== recipient.institutionId) {
    throw new Error("CROSS_INSTITUTION_TRANSFER")
  }

  await tx.case.update({
    where: { id: caseId },
    data: { userId: toUserId, caseCode },
  })

  return { previousCaseCode, caseCode, institutionId: current.institutionId }
}

/** Standalone/script wrapper. API routes use the in-transaction variant after
 * locking the parent case row with withLockedCaseTransaction. */
export async function transferCaseOwnership(
  db: PrismaClient,
  caseId: string,
  toUserId: string,
  opts: { supersedePending?: boolean; acceptTransferId?: string } = {},
): Promise<TransferOutcome> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(tx =>
        transferCaseOwnershipInTransaction(tx, caseId, toUserId, opts))
    } catch (error) {
      if (isPrismaUniqueError(error, "caseCode") && attempt < 4) continue
      throw error
    }
  }
}
