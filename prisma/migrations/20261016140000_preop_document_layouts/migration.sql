-- The print layout a hospital picks for the preop summary and consent
-- (A to E, B by default), and what each consent print carried: its layout
-- and, for layout C, the techniques the consent described.
ALTER TABLE "PreopDocumentPolicy" ADD COLUMN "layout" TEXT NOT NULL DEFAULT 'B';
ALTER TABLE "PreopDocumentPolicy" ADD CONSTRAINT "PreopDocumentPolicy_layout_known"
  CHECK ("layout" IN ('A', 'B', 'C', 'D', 'E'));

ALTER TABLE "CaseConsentPrint" ADD COLUMN "layout" TEXT,
ADD COLUMN "techniques" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "CaseConsentPrint" ADD CONSTRAINT "CaseConsentPrint_layout_known"
  CHECK ("layout" IS NULL OR "layout" IN ('A', 'B', 'C', 'D', 'E'));
