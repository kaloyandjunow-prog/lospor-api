-- What the monitor read, for the three modalities that carry a number.
--
-- Nullable and undefaulted on purpose. A case with the BIS switched on and no
-- value charted is an ordinary record, and a default of 0 would read as an
-- isoelectric EEG -- the same class of mistake as a recorded zero blood loss
-- meaning "not recorded".
--
-- cvpMmHg is millimetres of mercury whatever unit the clinician typed in. The
-- entry unit (cmH2O by default here) is a per-user display preference, and a
-- column whose unit followed it could not be pooled across cases at all.
ALTER TABLE "IntraoperativeRecord"
  ADD COLUMN "bisValue" INTEGER,
  ADD COLUMN "tofRatio" DOUBLE PRECISION,
  ADD COLUMN "cvpMmHg"  DOUBLE PRECISION;
