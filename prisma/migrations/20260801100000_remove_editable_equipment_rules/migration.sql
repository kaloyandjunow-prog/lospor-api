-- Equipment suggestions are fixed application guidance, not editable clinical
-- rules. This data-only migration removes legacy rows without changing any
-- preset, preset selection, or medication rule.

DELETE FROM "ClinicalRuleReview"
WHERE split_part("ruleKey", ':', 1) IN (
  'ADULT_EQUIPMENT_PROFILE',
  'PEDIATRIC_EQUIPMENT',
  'PEDIATRIC_EQUIPMENT_POLICY'
);

DELETE FROM "InstitutionClinicalRuleOverride"
WHERE "payload"->>'kind' IN (
    'ADULT_EQUIPMENT_PROFILE',
    'PEDIATRIC_EQUIPMENT',
    'PEDIATRIC_EQUIPMENT_POLICY'
  )
  OR split_part("ruleKey", ':', 1) IN (
    'ADULT_EQUIPMENT_PROFILE',
    'PEDIATRIC_EQUIPMENT',
    'PEDIATRIC_EQUIPMENT_POLICY'
  );

DELETE FROM "ClinicalPresetRule"
WHERE "payload"->>'kind' IN (
    'ADULT_EQUIPMENT_PROFILE',
    'PEDIATRIC_EQUIPMENT',
    'PEDIATRIC_EQUIPMENT_POLICY'
  )
  OR split_part("ruleKey", ':', 1) IN (
    'ADULT_EQUIPMENT_PROFILE',
    'PEDIATRIC_EQUIPMENT',
    'PEDIATRIC_EQUIPMENT_POLICY'
  );
