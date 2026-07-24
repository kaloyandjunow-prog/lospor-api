-- Start/end times: store real instants, not a bare wall clock.
--
-- Written by hand rather than via `prisma migrate dev`: that command wants to
-- reset the development database (pre-existing drift), which would destroy the
-- seeded option library, ICD-10 and concept-map data. Every statement below is
-- additive - no column is dropped and no row is rewritten.
--
-- Two defects share one cause: the column could not express the truth.
--
-- 1. `startTime` was NOT NULL, so "not started yet" had no legal value and the
--    code faked it as 2000-01-01T00:00:00Z. A JS Date is always truthy, so
--    every `if (startTime)` guard passed for a case that had never been
--    started - locking the UI to "00:00" with no way back, and leaving the
--    finalise guard permanently dead.
--
-- 2. `startTime`/`endTime` hold a local wall clock on a dummy date with no
--    timezone recorded, while CaseEvent.timestamp is a true UTC instant. The
--    two are different kinds of quantity. Comparing them put the chart anchor
--    one UTC offset out, which at UTC+3 always exceeded its own tolerance
--    window - so the v5.3.0 chart-origin fix silently never applied.

-- Let "not started" be NULL instead of a fabricated midnight.
ALTER TABLE "IntraoperativeRecord" ALTER COLUMN "startTime" DROP NOT NULL;

-- The real values. Nullable because a case genuinely may not have started yet,
-- and because legacy rows have no honest instant to put here.
ALTER TABLE "IntraoperativeRecord" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);
ALTER TABLE "IntraoperativeRecord" ADD COLUMN IF NOT EXISTS "endedAt"   TIMESTAMP(3);

-- IANA zone name (e.g. "Europe/Sofia"), not an offset: an offset cannot survive
-- a daylight-saving boundary, and a register that outlives one summer needs to
-- render historical local times correctly.
ALTER TABLE "IntraoperativeRecord" ADD COLUMN IF NOT EXISTS "timezone" TEXT;

-- Deliberately NO backfill of startedAt/endedAt from startTime/endTime.
--
-- Converting a wall clock to an instant requires knowing its timezone, and that
-- was never recorded. Guessing one would manufacture exactly the false
-- precision that makes a research register untrustworthy, and the error would
-- be indistinguishable from real data afterwards. Legacy rows keep their
-- existing columns and their existing (unchanged) chart behaviour;
-- `scripts/backfill-intraop-instants.ts` reports what a given assumed zone
-- would produce, for human review, and writes nothing unless asked.
