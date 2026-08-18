-- Finalization records become append-only.
--
-- CaseSnapshot described itself as immutable, held `caseId` UNIQUE, and was
-- written with an upsert whose update branch replaced both the document and its
-- timestamp. finalize -> unfinalize -> edit -> finalize therefore destroyed the
-- original attestation, and the surviving row kept the schemaVersion it was
-- first created with over a document of a different shape, because the update
-- branch never set it.

CREATE TABLE "CaseFinalization" (
  "id"                       TEXT         NOT NULL,
  "caseId"                   TEXT         NOT NULL,
  "sequence"                 INTEGER      NOT NULL,
  "schemaVersion"            TEXT         NOT NULL,
  "snapshotDocument"         TEXT         NOT NULL,
  "snapshotHash"             TEXT,
  "finalizedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finalizedById"            TEXT,
  "correctionReason"         TEXT,
  "supersedesFinalizationId" TEXT,

  CONSTRAINT "CaseFinalization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CaseFinalization_caseId_sequence_key"
  ON "CaseFinalization" ("caseId", "sequence");
CREATE UNIQUE INDEX "CaseFinalization_supersedesFinalizationId_key"
  ON "CaseFinalization" ("supersedesFinalizationId");
CREATE INDEX "CaseFinalization_caseId_finalizedAt_idx"
  ON "CaseFinalization" ("caseId", "finalizedAt");

ALTER TABLE "CaseFinalization"
  ADD CONSTRAINT "CaseFinalization_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CaseFinalization"
  ADD CONSTRAINT "CaseFinalization_supersedesFinalizationId_fkey"
  FOREIGN KEY ("supersedesFinalizationId") REFERENCES "CaseFinalization" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Carry every existing snapshot across as the first finalization of its case.
--
-- Two columns stay null, and deliberately so. These rows never recorded who
-- finalized them, and they were never hashed at the time -- a hash computed
-- here would attest to nothing except that this migration ran, while looking
-- exactly like one that had been taken at finalization. Null says what is
-- actually known.
INSERT INTO "CaseFinalization" (
  "id", "caseId", "sequence", "schemaVersion", "snapshotDocument", "finalizedAt"
)
SELECT "id", "caseId", 1, "schemaVersion", "snapshotJson"::text, "finalizedAt"
FROM "CaseSnapshot";

DROP TABLE "CaseSnapshot";

-- The immutability is enforced here rather than left to callers. The previous
-- guarantee was a comment, and a comment is what the upsert was written past.
CREATE OR REPLACE FUNCTION lospor_guard_finalization_immutable()
RETURNS trigger AS $$
BEGIN
  -- Deleting the parent case removes its finalizations with it. That is the
  -- account-erasure path and is controlled by the already-locked parent row.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'FINALIZATION_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CaseFinalization_guard_immutable"
BEFORE UPDATE OR DELETE ON "CaseFinalization"
FOR EACH ROW
EXECUTE FUNCTION lospor_guard_finalization_immutable();
