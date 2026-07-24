ALTER TABLE "CaseEvent" ADD COLUMN "bglLoincCode" TEXT;
ALTER TABLE "CaseEvent" ADD COLUMN "bglUnitCanon" TEXT;

UPDATE "CaseEvent"
SET "bgl" = NULLIF("metadataJson"->>'bgl', '')::double precision
WHERE "type" = 'vital'
  AND "bgl" IS NULL
  AND "metadataJson" ? 'bgl'
  AND ("metadataJson"->>'bgl') ~ '^-?[0-9]+(\.[0-9]+)?$';

UPDATE "CaseEvent"
SET "bglLoincCode" = '2345-7',
    "bglUnitCanon" = 'mmol/L'
WHERE "type" = 'vital'
  AND "bgl" IS NOT NULL;
