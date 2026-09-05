-- Retire the glucose vital and the two monitoring flags it depended on.
--
-- Serum and peripheral glucose left the monitoring options when the
-- intraoperative labs lane was built. That made bglMonitor unofferable, and the
-- glucose vital row on both clients gated on it -- so the lane could never
-- appear again on any case created since. It has been dead UI over a dead
-- column, which is worse than either alone: it invites someone to "fix" the
-- gate and reopen a second route for the same measurement.
--
-- Glucose is charted as a lab draw now, carrying its own draw time. The labs
-- library codes it to LOINC 2345-7 in mmol/L, which is exactly the code and
-- unit this vital hardcoded, so the two paths produced identical MEASUREMENT
-- rows. Nothing is lost by keeping the one that a clinician can actually reach.
--
-- bloodGasMonitor goes with it: dropped from the monitoring options by the same
-- decision, read by the sync mirror and exported nowhere, and blood gas results
-- now arrive through the same labs lane.
--
-- Safe to drop rather than deprecate: no case exists in any environment. The
-- cloud has never been used and the appliance has never been installed, so
-- there is no charted glucose vital anywhere to strand.
ALTER TABLE "CaseEvent"
  DROP COLUMN "bgl",
  DROP COLUMN "bglLoincCode",
  DROP COLUMN "bglUnitCanon";

ALTER TABLE "IntraoperativeRecord"
  DROP COLUMN "bglMonitor",
  DROP COLUMN "bloodGasMonitor";
