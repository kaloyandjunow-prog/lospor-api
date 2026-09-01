-- Estimated blood loss, entered by the anaesthetist.
--
-- Deliberately nullable with no default: crystalloidsMl, colloidsMl and bloodMl
-- are projections of the fluid events and are written server-side, but blood
-- lost is an observation only the clinician can make. NULL therefore means "not
-- recorded", which is a different clinical statement from a recorded 0 mL, and
-- the two must stay distinguishable end to end.
ALTER TABLE "IntraoperativeRecord" ADD COLUMN "bloodLossMl" INTEGER;
