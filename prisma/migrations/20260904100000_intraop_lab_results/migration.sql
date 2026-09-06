-- Laboratory results drawn during a case.
--
-- Preoperative labs are one snapshot taken before the case. Intraoperative ones
-- are repeated draws during it -- a gas at induction, another after the blood,
-- a haemoglobin an hour later -- each with its own draw time. They are
-- otherwise the same clinical object: same catalogue, same units, same
-- reference ranges, same LOINC mapping. So they share LabResult rather than a
-- parallel table that would have to duplicate all of that.
--
-- The JSON column is the source of truth the clinician edits, exactly as
-- PreoperativeAssessment.labResults already is; the LabResult rows are the
-- queryable mirror relational-sync derives from it.
ALTER TABLE "IntraoperativeRecord" ADD COLUMN "labResults" JSONB NOT NULL DEFAULT '[]';

-- LabResult gains a second possible parent. `section` names which one without
-- having to test the two ids, and every existing row is preoperative by
-- definition, which is what the default backfills.
ALTER TABLE "LabResult" ADD COLUMN "section" TEXT NOT NULL DEFAULT 'preop';
ALTER TABLE "LabResult" ADD COLUMN "intraopId" TEXT;

-- preopId was NOT NULL while preop was the only possible parent. An
-- intraoperative result has no preop record to point at, so the column becomes
-- nullable. Existing rows are unaffected: they all still carry their preopId.
ALTER TABLE "LabResult" ALTER COLUMN "preopId" DROP NOT NULL;

-- Each parent keeps its own cascade, so deleting either record takes its own
-- results with it.
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_intraopId_fkey"
  FOREIGN KEY ("intraopId") REFERENCES "IntraoperativeRecord"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "LabResult_intraopId_idx" ON "LabResult"("intraopId");
