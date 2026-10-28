-- Postoperative pain and emergence delirium scored item by item (10.0.0):
-- FLACC (5 items, 0-2) and its total, FPS-R (one of six faces), NIPS for a
-- newborn (6 items) and its total, and PAED's five items (its total is the
-- existing paedScore). Nullable, no default: existing records are not rewritten.
ALTER TABLE "PostoperativeRecord" ADD COLUMN "flaccFace" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "flaccLegs" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "flaccActivity" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "flaccCry" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "flaccConsolability" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "flaccTotal" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "fpsrScore" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "nipsFacialExpression" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "nipsCry" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "nipsBreathing" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "nipsArms" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "nipsLegs" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "nipsArousal" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "nipsTotal" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "paedEyeContact" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "paedPurposeful" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "paedAware" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "paedRestless" INTEGER;
ALTER TABLE "PostoperativeRecord" ADD COLUMN "paedInconsolable" INTEGER;
