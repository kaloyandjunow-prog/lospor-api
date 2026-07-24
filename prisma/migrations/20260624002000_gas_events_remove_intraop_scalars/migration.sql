ALTER TABLE "CaseEvent"
  ADD COLUMN IF NOT EXISTS "fgfLitersPerMin" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "carrierGas" TEXT,
  ADD COLUMN IF NOT EXISTS "fio2Percent" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "fiAirPercent" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "fiN2OPercent" DOUBLE PRECISION;

WITH gas AS (
  SELECT
    id,
    NULLIF("metadataJson"->>'fgf', '')::DOUBLE PRECISION AS fgf,
    NULLIF("metadataJson"->>'carrierGas', '') AS carrier_gas,
    CASE
      WHEN NULLIF("metadataJson"->>'carrierGas', '') IS NULL THEN 100
      ELSE LEAST(100, GREATEST(21, COALESCE(NULLIF("metadataJson"->>'fio2', '')::DOUBLE PRECISION, 21)))
    END AS fio2
  FROM "CaseEvent"
  WHERE type IN ('gas_start', 'gas_change')
)
UPDATE "CaseEvent" ce
SET
  "fgfLitersPerMin" = gas.fgf,
  "carrierGas" = CASE WHEN gas.carrier_gas IN ('air', 'n2o') THEN gas.carrier_gas ELSE NULL END,
  "fio2Percent" = gas.fio2,
  "fiAirPercent" = CASE WHEN gas.carrier_gas = 'air' THEN 100 - gas.fio2 ELSE 0 END,
  "fiN2OPercent" = CASE WHEN gas.carrier_gas = 'n2o' THEN 100 - gas.fio2 ELSE 0 END
FROM gas
WHERE ce.id = gas.id;

ALTER TABLE "IntraoperativeRecord"
  DROP CONSTRAINT IF EXISTS "IntraoperativeRecord_carrierGas_check";

ALTER TABLE "IntraoperativeRecord"
  DROP COLUMN IF EXISTS "n2oPercent",
  DROP COLUMN IF EXISTS "o2Percent",
  DROP COLUMN IF EXISTS "n2oLitersPerMin",
  DROP COLUMN IF EXISTS "o2LitersPerMin",
  DROP COLUMN IF EXISTS "fgfLitersPerMin",
  DROP COLUMN IF EXISTS "carrierGas",
  DROP COLUMN IF EXISTS "fio2Percent";
