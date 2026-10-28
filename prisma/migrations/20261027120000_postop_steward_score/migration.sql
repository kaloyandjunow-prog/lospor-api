-- A child's recovery is scored on Steward instead of Aldrete (10.0.0):
-- consciousness, airway and movement, 0-2 each, and their 0-6 total.
-- Nullable, no default: existing records are not rewritten.
ALTER TABLE "PostoperativeRecord" ADD COLUMN "stewardConsciousness" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "stewardAirway" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "stewardMovement" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "stewardTotal" INTEGER;
