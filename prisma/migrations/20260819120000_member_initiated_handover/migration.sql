-- Member-initiated case handover.
--
-- Until now a case could only be reassigned by a head of department or an
-- administrator, and it moved immediately. A member handing a case to a
-- colleague -- at the end of a shift, or after a pre-assessment done days
-- before -- had no route through the system at all.
--
-- A member's handover is a request: nothing moves until the recipient accepts.

-- Withdrawn by the sender, as distinct from refused by the recipient. A trail
-- that recorded both as DECLINED could not tell the two apart, and they are the
-- two things anyone would actually want to know.
ALTER TYPE "TransferStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- The sender's own "awaiting acceptance" list. Without it that view scans every
-- transfer ever recorded.
CREATE INDEX IF NOT EXISTS "CaseTransfer_fromUserId_status_idx"
  ON "CaseTransfer" ("fromUserId", "status");

-- One pending handover per case, enforced by the database rather than by the
-- route remembering to check. Two people cannot both be waiting to be told a
-- case is theirs: whichever accepted second would find it already renumbered
-- into someone else's sequence.
--
-- Deliberately no data fix-up before this. No PENDING row has ever been written
-- -- the only caseTransfer.create in the codebase hardcoded ACCEPTED -- so
-- there is nothing to reconcile, and if that assumption is wrong on some
-- database then this migration must stop rather than quietly resolve clinical
-- records to make itself succeed.
CREATE UNIQUE INDEX IF NOT EXISTS "CaseTransfer_one_pending_per_case"
  ON "CaseTransfer" ("caseId")
  WHERE "status" = 'PENDING';
