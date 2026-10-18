-- Millilitres given through drug infusions, derived from their recorded pump
-- rates and counted in the fluid balance (2026-10-18). Nullable, no default:
-- existing records are not rewritten.
ALTER TABLE "IntraoperativeRecord" ADD COLUMN "infusionsMl" INTEGER;
