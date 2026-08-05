-- Every case belongs to an institution.
--
-- The user backfill in 20260805140000 left Case.institutionId alone, on the
-- reasoning that assigning an unstamped case to a department would invent
-- provenance. Assigning it to "Без институция" does not: that institution is
-- precisely the statement "no department", which is what a NULL already meant.
--
-- Visibility is unchanged. Без институция has no head of department, so these
-- cases stay with the clinician who recorded them and with administrators,
-- exactly as they did while NULL. What changes is that the column no longer
-- carries two ways of saying the same thing.

UPDATE "Case"
SET "institutionId" = 'no-institution'
WHERE "institutionId" IS NULL;
