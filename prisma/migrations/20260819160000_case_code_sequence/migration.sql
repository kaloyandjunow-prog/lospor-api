-- A forward-only case-number counter, per clinician per year.
--
-- Case codes were derived from the highest code a clinician currently owned.
-- Ownership changes on handover, so that ceiling could move backwards: hand
-- away your highest case and the next case you create takes the number you just
-- handed over. Demonstrated on a real database -- a clinician holding
-- 2026-0001..0003 who hands 0003 to a colleague gets 2026-0003 again for their
-- next case, and two different operations then carry the same number on paper.
-- The unique constraint is (userId, caseCode) and the handed-over case now
-- belongs to someone else, so nothing rejected it.
--
-- Gaps were always possible and remain so; a deleted draft leaves one. Reuse is
-- the thing that must not happen, because the code is the only link between a
-- printed chart and its record.

CREATE TABLE IF NOT EXISTS "CaseCodeSequence" (
  "userId" TEXT NOT NULL,
  "year"   INTEGER NOT NULL,
  "next"   INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "CaseCodeSequence_pkey" PRIMARY KEY ("userId", "year")
);

-- Backfill from what each clinician has already been issued, so no number is
-- ever handed out twice.
--
-- Seeded here rather than lazily on first use: a lazy seed would read the
-- current maximum, and if a handover had already lowered it the counter would
-- start below a number that is already on a chart. Doing it in the migration
-- closes that window before any handover can open it.
INSERT INTO "CaseCodeSequence" ("userId", "year", "next")
SELECT
  "userId",
  CAST(substring("caseCode" from 1 for 4) AS INTEGER) AS "year",
  MAX(CAST(substring("caseCode" from 6) AS INTEGER)) + 1 AS "next"
FROM "Case"
WHERE "caseCode" ~ '^[0-9]{4}-[0-9]+$'
GROUP BY "userId", CAST(substring("caseCode" from 1 for 4) AS INTEGER)
ON CONFLICT ("userId", "year") DO NOTHING;
