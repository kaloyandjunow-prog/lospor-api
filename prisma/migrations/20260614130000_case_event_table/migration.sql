-- Event-sourced clinical events (additive; dual-written alongside keyEvents.log).
CREATE TABLE "CaseEvent" (
  "id"             TEXT NOT NULL,
  "caseId"         TEXT NOT NULL,
  "userId"         TEXT,
  "type"           TEXT NOT NULL,
  "timestamp"      TIMESTAMP(3) NOT NULL,
  "label"          TEXT,
  "value"          TEXT,
  "unit"           TEXT,
  "metadataJson"   JSONB,
  "source"         TEXT NOT NULL DEFAULT 'mobile',
  "idempotencyKey" TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CaseEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CaseEvent_idempotencyKey_key" ON "CaseEvent"("idempotencyKey");
CREATE INDEX "CaseEvent_caseId_timestamp_idx" ON "CaseEvent"("caseId", "timestamp");

ALTER TABLE "CaseEvent"
  ADD CONSTRAINT "CaseEvent_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
