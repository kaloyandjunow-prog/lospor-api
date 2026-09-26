-- 1.4.9: a case started 48 hours ago, not ended and with no screen open on it
-- ends on its own at its last recorded entry, so a forgotten case cannot keep
-- growing (autofill, running infusions). This marks those ends, so the apps
-- can say so and Resume can clear it.
ALTER TABLE "IntraoperativeRecord" ADD COLUMN "autoEndedAt" TIMESTAMP(3);
