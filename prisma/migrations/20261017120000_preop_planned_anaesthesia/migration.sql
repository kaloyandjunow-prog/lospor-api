-- The anaesthesia planned at the preop visit (optional), in the intraoperative
-- record's own menus: technique codes, airway devices and instruments, lines,
-- and whether ventilation after the operation is planned (Core preop-plan).
-- Layout C of the consent starts from it. An object; empty when nothing is planned.
ALTER TABLE "PreoperativeAssessment"
  ADD COLUMN "plannedAnaesthesia" JSONB NOT NULL DEFAULT '{}'::JSONB;

ALTER TABLE "PreoperativeAssessment"
  ADD CONSTRAINT "PreoperativeAssessment_plannedAnaesthesia_object"
  CHECK (jsonb_typeof("plannedAnaesthesia") = 'object');
