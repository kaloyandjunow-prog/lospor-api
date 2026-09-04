-- Timed readings for the three monitors that produce a number.
--
-- These sit on CaseEvent beside the other vitals rather than as one value per
-- case, because when a reading was taken is part of what it means: a BIS of 22
-- matters for how long it stayed there, and a train-of-four of 0.4 means one
-- thing at incision and another at extubation.
--
-- Nullable and undefaulted, and this is load-bearing for two of them. A BIS of
-- 0 is an isoelectric EEG and a train-of-four of 0 is a fully paralysed
-- patient: both are real readings a clinician would chart, so a default of 0
-- would make "not recorded" indistinguishable from a genuine zero.
--
-- cvp is millimetres of mercury whatever unit was typed. The entry unit
-- (cmH2O by default) is a per-user display preference; converting at entry
-- rather than at export keeps the stored figure independent of it.
ALTER TABLE "CaseEvent"
  ADD COLUMN "bis"      DOUBLE PRECISION,
  ADD COLUMN "tofRatio" DOUBLE PRECISION,
  ADD COLUMN "cvp"      DOUBLE PRECISION;
