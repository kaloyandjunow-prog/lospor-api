-- The arterial line reads its own pressure, and the cuff's mean is kept (10.2.0).
--
-- These sit on CaseEvent beside systolic and diastolic, which stay what they
-- were: the cuff (NIBP). Existing readings are not touched and not relabelled
-- in the data; only the screens now call that pair NIBP. A reading from the
-- arterial line goes in ibpSystolic / ibpDiastolic / ibpMap, and the cuff's
-- mean pressure, when the monitor shows one, in nibpMap.
--
-- Nullable and undefaulted: "not recorded" must stay distinct from a real
-- reading, and a case without an arterial line has no IBP at all.
ALTER TABLE "CaseEvent"
  ADD COLUMN "ibpSystolic"  INTEGER,
  ADD COLUMN "ibpDiastolic" INTEGER,
  ADD COLUMN "ibpMap"       INTEGER,
  ADD COLUMN "nibpMap"      INTEGER;
