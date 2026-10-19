-- The ASA class the suggestion rules proposed, beside the class chosen.
--
-- Written at every preop save from the record's coded conditions and BMI by
-- the same Core rules both clients show, with the rule-table version, so the
-- research view can say per rule how often anaesthetists agreed. Nothing is
-- backfilled: no appliance holds live cases yet.
ALTER TABLE "PreoperativeAssessment"
  ADD COLUMN "asaSuggestedScore" "ASAScore",
  ADD COLUMN "asaSuggestionReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "asaSuggestionRulesVersion" TEXT;
