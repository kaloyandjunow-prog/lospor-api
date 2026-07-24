-- Add persisted clinical form state fields that are already present in the
-- Prisma schema and application payloads.
ALTER TABLE "PreoperativeAssessment"
    ADD COLUMN IF NOT EXISTS "bpUnobtainable" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "heartRateUnobtainable" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "spO2Unobtainable" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "temperatureUnobtainable" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "respiratoryRateUnobtainable" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "airwayUnobtainable" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "elective" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "IntraoperativeRecord"
    ADD COLUMN IF NOT EXISTS "lmaSize" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "oralTubeSize" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "oralCuffed" BOOLEAN,
    ADD COLUMN IF NOT EXISTS "nasalTubeSize" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "nasalCuffed" BOOLEAN;

ALTER TABLE "PostoperativeRecord"
    ADD COLUMN IF NOT EXISTS "recoveryBpUnobtainable" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "recoveryHeartRateUnobtainable" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "recoverySpO2Unobtainable" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "recoveryTemperatureUnobtainable" BOOLEAN NOT NULL DEFAULT false;
