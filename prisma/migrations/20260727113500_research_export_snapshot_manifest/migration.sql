ALTER TABLE "ResearchExport"
  ADD COLUMN "snapshotRevisions" JSONB,
  ADD COLUMN "snapshotHash" TEXT,
  ADD COLUMN "snapshotCaseCount" INTEGER;

COMMENT ON COLUMN "ResearchExport"."snapshotRevisions" IS 'Frozen case IDs and updatedAt revisions captured when the export request is created.';
