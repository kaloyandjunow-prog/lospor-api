-- Phase E: versioning + lifecycle on CaseEvent so the table is the source of
-- truth for the intraop chart (edits supersede, deletes tombstone; nothing is
-- ever hard-deleted).
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "logicalId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "version"   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "status"    TEXT NOT NULL DEFAULT 'active';

-- Backfill logicalId from the existing idempotencyKey (format "caseId:logicalId";
-- caseId is a cuid with no colon, so everything after the first colon is the id).
UPDATE "CaseEvent"
  SET "logicalId" = substring("idempotencyKey" from position(':' in "idempotencyKey") + 1)
  WHERE "logicalId" = '' AND position(':' in "idempotencyKey") > 0;

CREATE INDEX IF NOT EXISTS "CaseEvent_caseId_status_idx"    ON "CaseEvent"("caseId", "status");
CREATE INDEX IF NOT EXISTS "CaseEvent_caseId_logicalId_idx" ON "CaseEvent"("caseId", "logicalId");
