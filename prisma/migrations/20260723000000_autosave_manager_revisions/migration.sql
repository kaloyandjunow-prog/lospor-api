ALTER TABLE "PreoperativeAssessment"
ADD COLUMN "syncRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "IntraoperativeRecord"
ADD COLUMN "syncRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PostoperativeRecord"
ADD COLUMN "syncRevision" INTEGER NOT NULL DEFAULT 0;
