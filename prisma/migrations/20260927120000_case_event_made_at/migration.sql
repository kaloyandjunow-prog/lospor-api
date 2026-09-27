-- 9.13.0: when each event change was made on the device, so the last change
-- made wins across devices rather than the last to arrive. An older edit or
-- deletion that reaches the server after a newer one is refused, not applied
-- over it. Null for every row written before this; those never refuse.
ALTER TABLE "CaseEvent" ADD COLUMN "madeAt" TIMESTAMP(3);
