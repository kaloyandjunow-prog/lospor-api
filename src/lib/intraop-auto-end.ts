import { prisma } from "@/lib/prisma"
import {
  INTRAOP_AUTO_END_AFTER_MS,
  intraopAutoEndInstant,
  shouldAutoEndIntraopCase,
} from "@lospor/core/intraop-commands"
import { parseLogEvents } from "@lospor/core/intraop-types"
import { activeCaseLog, rebuildProjection } from "@/lib/case-events"
import { logAuditInTransaction } from "@/lib/audit"
import { withLockedCaseTransaction } from "@/lib/clinical-transaction"

/**
 * Ends a case that was started 48 hours ago, has had nothing saved to it for 48
 * hours, was never ended, and has no screen open on it (1.4.9).
 *
 * A forgotten case otherwise keeps growing: autofill keeps charting, running
 * infusions keep adding to their totals, and the chart is read at an ever later
 * "now". The end is the last recorded entry, not the moment of the sweep, so
 * nothing is invented. Running items become continued postoperatively (no stop
 * is written; the chart and every total are capped at the end) and planned
 * entries after the end stay listed, so finalisation still asks about them.
 * The case stays open: Resume takes the end back and clears the mark.
 *
 * Triggered three ways: the appliance worker's five-minute sweep (through
 * close-expired-cases), a daily cron on the hosted deployment, and whenever
 * the case is opened.
 */

/** The system actor recorded for an automatic end; never a clinician. */
export const AUTO_END_SYSTEM_ACTOR_ID = "System (automatic end after 48 hours)"

export type AutoEndSweep = { scanned: number; ended: number; failed: number }

/** Ends one case if it qualifies. Returns the end instant written, or null. */
export async function autoEndCaseIfStale(caseId: string, now = new Date()): Promise<Date | null> {
  return withLockedCaseTransaction(caseId, async tx => {
    const record = await tx.case.findUnique({
      where: { id: caseId },
      select: {
        status: true,
        userId: true,
        intraop: { select: { startedAt: true, endedAt: true, updatedAt: true } },
        lock: { select: { expiresAt: true } },
      },
    })
    if (!record?.intraop || record.status === "COMPLETE") return null
    if (!shouldAutoEndIntraopCase({
      startedAt: record.intraop.startedAt,
      endedAt: record.intraop.endedAt,
      now,
      screenOpenUntil: record.lock?.expiresAt ?? null,
      lastSavedAt: record.intraop.updatedAt,
    })) return null

    const endedAt = intraopAutoEndInstant(
      parseLogEvents(await activeCaseLog(tx, caseId)),
      record.intraop.startedAt!,
      now,
    )
    await tx.intraoperativeRecord.update({
      where: { caseId },
      data: { endedAt, autoEndedAt: now, syncRevision: { increment: 1 } },
    })
    await rebuildProjection(tx, caseId, { revisionAlreadyReserved: true })
    await logAuditInTransaction(tx, AUTO_END_SYSTEM_ACTOR_ID, "CASE_INTRAOP_AUTO_ENDED", caseId, {
      assignedUserId: record.userId,
      endedAt: endedAt.toISOString(),
      startedAt: record.intraop.startedAt!.toISOString(),
    })
    return endedAt
  })
}

/** The sweep: every qualifying case, oldest first, bounded per run. */
export async function autoEndStaleIntraopCases(
  options: { limit?: number; now?: Date } = {},
): Promise<AutoEndSweep> {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - INTRAOP_AUTO_END_AFTER_MS)
  const due = await prisma.intraoperativeRecord.findMany({
    where: {
      startedAt: { not: null, lte: cutoff },
      // Nothing saved for 48 hours either: a case charted retrospectively is
      // being worked on, whatever its start says.
      updatedAt: { lte: cutoff },
      endedAt: null,
      case: {
        status: { not: "COMPLETE" },
        OR: [{ lock: null }, { lock: { expiresAt: { lte: now } } }],
      },
    },
    select: { caseId: true },
    orderBy: { startedAt: "asc" },
    take: options.limit ?? 25,
  })

  const sweep: AutoEndSweep = { scanned: due.length, ended: 0, failed: 0 }
  for (const { caseId } of due) {
    try {
      if (await autoEndCaseIfStale(caseId, now)) sweep.ended += 1
    } catch {
      // One case failing must not stop the sweep; it runs unattended. A fixed
      // code only: runtime logs never carry case data.
      sweep.failed += 1
      console.error("[intraop-auto-end] INTRAOP_AUTO_END_FAILED")
    }
  }
  return sweep
}
