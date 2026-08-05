-- Everyone belongs to an institution.
--
-- Registration now requires one, and a case is stamped with its author's
-- institution at creation. Accounts predating that carry NULL, and a case they
-- record would still be stamped NULL — reintroducing exactly the unstamped
-- cases whose visibility used to follow their author between departments.
--
-- "Без институция" is a real institution for clinicians with no department. It
-- is created here rather than only in the seed so the invariant holds on every
-- installation, including ones that never run seeds.

INSERT INTO "Institution" ("id", "name", "city", "country")
VALUES ('no-institution', 'Без институция', '—', 'Bulgaria')
ON CONFLICT ("id") DO NOTHING;

UPDATE "User"
SET "institutionId" = 'no-institution'
WHERE "institutionId" IS NULL;

-- Cases are deliberately NOT backfilled. A case with no institution belongs to
-- no department, and assigning it to one now would invent provenance for work
-- whose location was never recorded. It stays visible to the clinician who
-- recorded it and to administrators, which is the honest reading.
