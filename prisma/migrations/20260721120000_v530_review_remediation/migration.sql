-- v5.3.0 — external review remediation.
--
-- Written by hand rather than via `prisma migrate dev`: that command wanted to
-- reset the development database (pre-existing drift), which would have
-- destroyed the seeded option library, ICD-10 and concept-map data. Every
-- statement below is additive — no column, index or row is dropped.

-- "Not recorded" is not a finding. Unrecorded sex previously defaulted to
-- OTHER, which merges "nobody asked" with "recorded as other" and corrupts any
-- denominator a researcher computes. Existing OTHER rows are deliberately left
-- untouched: we cannot know retrospectively which of them meant "unknown".
ALTER TYPE "Sex" ADD VALUE IF NOT EXISTS 'UNKNOWN';

-- Case codes are per-user sequences that both start at 0001, so a transferred
-- case may have to be renumbered into the recipient's sequence. Keep the code
-- it carried before, otherwise the printed record and the database disagree
-- with no way to reconcile them.
ALTER TABLE "CaseTransfer" ADD COLUMN IF NOT EXISTS "previousCaseCode" TEXT;

-- "Everything this user did" and "everything that happened to this case" were
-- both full table scans. AuditLog.userId is deliberately NOT a foreign key —
-- audit rows must outlive the account they describe, so the retention purge
-- cannot cascade the evidence away.
CREATE INDEX IF NOT EXISTS "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_entityId_createdAt_idx" ON "AuditLog"("entityId", "createdAt");

-- Custom-term dedupe was read-then-write, which races when two clinicians first
-- use the same term at once. Let the database arbitrate. NULL institutionId
-- rows (the legacy global scope) are not covered — Postgres treats NULLs as
-- distinct — which is intentional.
CREATE UNIQUE INDEX IF NOT EXISTS "CustomTerm_institutionId_termType_term_key"
  ON "CustomTerm"("institutionId", "termType", "term");

-- Cosmetic: Postgres truncated this identifier at creation time, so it has
-- never matched what Prisma expects and every diff since has proposed the
-- rename. Renaming keeps future diffs clean; the index itself is unchanged.
ALTER INDEX IF EXISTS "OmopConceptRelationship_conceptId1_conceptId2_relationshipId_ke"
  RENAME TO "OmopConceptRelationship_conceptId1_conceptId2_relationshipI_key";
