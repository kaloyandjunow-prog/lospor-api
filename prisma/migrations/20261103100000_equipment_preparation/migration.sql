-- Smart Equipment preparation is a reversible reference state, not a clinical event.
ALTER TABLE "IntraoperativeRecord"
  ADD COLUMN "equipmentPrepared" JSONB NOT NULL DEFAULT '{}';
