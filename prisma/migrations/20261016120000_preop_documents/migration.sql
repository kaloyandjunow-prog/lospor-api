-- The preop summary page and the written consent for anaesthesia (9.15.0).
--
-- Both are off unless an operator switches them on in Status. Consent texts
-- are kept as an append-only list of versions; a print records the version
-- and fingerprint of the text on the sheet. Nothing is backfilled: no
-- appliance holds live cases yet.
CREATE TABLE "PreopDocumentPolicy" (
  "id" TEXT NOT NULL DEFAULT 'local',
  "summaryEnabled" BOOLEAN NOT NULL DEFAULT false,
  "consentEnabled" BOOLEAN NOT NULL DEFAULT false,
  "changedById" TEXT,
  "changeReason" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PreopDocumentPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConsentTemplateVersion" (
  "id" TEXT NOT NULL,
  "population" "ClinicalMode" NOT NULL,
  "version" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "createdById" TEXT,
  "changeReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsentTemplateVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConsentTemplateVersion_version_positive" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "ConsentTemplateVersion_population_version_key" ON "ConsentTemplateVersion"("population", "version");

-- A saved text is evidence of what a patient may have signed: never rewritten.
CREATE OR REPLACE FUNCTION lospor_consent_template_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CONSENT_TEMPLATE_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ConsentTemplateVersion_append_only"
BEFORE UPDATE OR DELETE ON "ConsentTemplateVersion"
FOR EACH ROW EXECUTE FUNCTION lospor_consent_template_append_only();

CREATE TABLE "CaseConsentPrint" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "population" "ClinicalMode" NOT NULL,
  "templateVersion" INTEGER NOT NULL,
  "templateVersionId" TEXT,
  "bodySha256" TEXT NOT NULL,
  "printedById" TEXT NOT NULL,
  "printedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CaseConsentPrint_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CaseConsentPrint_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CaseConsentPrint_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "ConsentTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "CaseConsentPrint_caseId_printedAt_idx" ON "CaseConsentPrint"("caseId", "printedAt");

-- No print is recorded onto a finalised case. It does not touch the case's
-- revision: printing changes nothing a client has to sync.
CREATE TRIGGER "CaseConsentPrint_guard_case_write"
BEFORE INSERT OR UPDATE OR DELETE ON "CaseConsentPrint"
FOR EACH ROW EXECUTE FUNCTION lospor_guard_clinical_child_write();
