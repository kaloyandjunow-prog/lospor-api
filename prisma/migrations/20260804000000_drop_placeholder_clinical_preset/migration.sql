-- Remove the placeholder clinical preset seeded during the ruleset migration.
--
-- 20260730140000_clinical_rule_presets created 'lospor-standard-v1' as a
-- PUBLISHED preset with no rules, purely to satisfy the NOT NULL foreign keys it
-- was adding, and backfilled every Institution to it.
-- 20260731100000_clinical_ruleset_hierarchy then turned that backfill into one
-- InstitutionClinicalPresetSelection row per institution, and pointed the
-- platform pediatric selection at the same empty preset.
--
-- Left in place, that is not inert. Preset resolution walks
-- [user, institution, platform] and takes the first PUBLISHED preset matching the
-- clinical mode; it does not require the preset to contain any rules. So every
-- institution would resolve pediatric dosing to an empty ruleset -- no drug
-- profiles, no dose autofill -- while every "is a preset selected?" health check
-- reported success. Worse, publishing a real pediatric ruleset at PLATFORM scope
-- afterwards would not take effect, because the institution-level selections win.
--
-- Dropping the placeholder lets institutions fall through to the platform
-- selection, which is what the hierarchy exists to do. The preset itself is only
-- ever referenced by those two migrations; no application code names it.
--
-- Each delete is conditional, so this is safe on a database where the placeholder
-- was already cleaned up, and refuses to destroy anything that turned out to be
-- load-bearing.

DELETE FROM "InstitutionClinicalPresetSelection"
WHERE "presetId" = 'lospor-standard-v1';

DELETE FROM "UserClinicalPresetSelection"
WHERE "presetId" = 'lospor-standard-v1';

DELETE FROM "PlatformClinicalPresetSelection"
WHERE "presetId" = 'lospor-standard-v1';

-- Only drop the preset if it is genuinely the empty placeholder: no rules, no
-- institution overrides hanging off it, and no recorded dose citing it as
-- provenance. If any of those exist the preset stays, and the selections above
-- having been removed is still the correct outcome.
DELETE FROM "ClinicalPreset" p
WHERE p."id" = 'lospor-standard-v1'
  AND NOT EXISTS (
    SELECT 1 FROM "ClinicalPresetRule" r WHERE r."presetId" = p."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "InstitutionClinicalRuleOverride" o WHERE o."presetId" = p."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "CaseEvent" e WHERE e."clinicalPresetId" = p."id"
  );
