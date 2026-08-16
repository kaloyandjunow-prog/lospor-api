-- Yes / No / not asked for the questions a clinician actually asks.
--
-- These were Boolean @default(false), so a row was born asserting "no" to every
-- question before anyone had been asked one. A field nobody touched and a field
-- a clinician deliberately answered "no" were the same value, and no later layer
-- could tell them apart: ClinicalFieldPresence derives ABSENT from false, so the
-- ambiguity propagated all the way into the OMOP export.
--
-- Dropping the default and allowing NULL gives the third state. presence()
-- already reads null as NOT_DOCUMENTED, true as PRESENT and false as ABSENT, so
-- no derivation logic changes -- the information simply stops being destroyed at
-- the point of storage.
--
-- Existing rows are deliberately left as they are. Their false values are
-- ambiguous, but rewriting them to NULL would discard the genuine "no" answers
-- among them, and asserting either reading would be a clinical claim this
-- migration is not entitled to make.
--
-- Only questions asked of a patient are included. Monitoring and equipment
-- checkboxes stay boolean because unticked means not used; the vitals
-- "unobtainable" ticks stay boolean because they already record missingness;
-- and emergency/high-risk stay boolean because they are genuinely binary --
-- not emergent means elective, not high risk means not high risk.

ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "allergies" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "allergies" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "latexAllergy" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "latexAllergy" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "familyAnesthesiaProblems" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "familyAnesthesiaProblems" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "dentalProsthetics" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "dentalProsthetics" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "looseTeeth" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "looseTeeth" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "smoking" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "smoking" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "substanceAbuse" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "substanceAbuse" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "heartArrhythmia" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "heartArrhythmia" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "retrognathia" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "retrognathia" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "prominentIncisors" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "prominentIncisors" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "facialHair" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "facialHair" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "difficultAirwayHistory" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "difficultAirwayHistory" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "rcriIschemicHeart" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "rcriIschemicHeart" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "rcriCHF" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "rcriCHF" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "rcriCVD" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "rcriCVD" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "rcriInsulinDM" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "rcriInsulinDM" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "rcriCreatinine" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "rcriCreatinine" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "apfelPONVHistory" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "apfelPONVHistory" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "apfelPostopOpioids" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "apfelPostopOpioids" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "stopbangSnoring" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "stopbangSnoring" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "stopbangTired" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "stopbangTired" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "stopbangObserved" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "stopbangObserved" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "stopbangBP" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "stopbangBP" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "stopbangNeck" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "stopbangNeck" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "povocSurgeryAtLeast30Minutes" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "povocSurgeryAtLeast30Minutes" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "povocAgeAtLeast3Years" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "povocAgeAtLeast3Years" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "povocStrabismusSurgery" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "povocStrabismusSurgery" DROP NOT NULL;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "povocHistory" DROP DEFAULT;
ALTER TABLE "PreoperativeAssessment" ALTER COLUMN "povocHistory" DROP NOT NULL;
ALTER TABLE "PostoperativeRecord" ALTER COLUMN "ponv" DROP DEFAULT;
ALTER TABLE "PostoperativeRecord" ALTER COLUMN "ponv" DROP NOT NULL;
