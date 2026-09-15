# Third-party content

LOSPOR's own code is licensed under the GNU AGPL v3 (see `LICENSE`). The
reference data below is not LOSPOR's work. It keeps its owners' rights and
terms, and is included only so that clinicians can code what they record. The
shared vocabularies bundled from `@lospor/core` are described in that
package's `NOTICE.md`.

## LOINC

The lab seed (`scripts/seed-lab-loinc.ts`), the NHIS laboratory mapping
(`scripts/nhis-cl024-lab-mappings.ts`), the research export and the data
dictionary carry LOINC codes.

This material contains content from LOINC (http://loinc.org). LOINC is
copyright © 1995-2026, Regenstrief Institute, Inc. and the Logical Observation
Identifiers Names and Codes (LOINC) Committee and is available at no cost under
the license at http://loinc.org/license. LOINC® is a registered United States
trademark of Regenstrief Institute, Inc.

## Procedures

`src/data/pcs.json` holds ICD-10-PCS codes and descriptions (U.S. Centers for
Medicare & Medicaid Services, public domain), grouped by the Clinical
Classifications Software Refined for ICD-10-PCS procedures (PRCCSR) v2025.1,
Healthcare Cost and Utilization Project (HCUP), Agency for Healthcare Research
and Quality (https://hcup-us.ahrq.gov).

`src/data/icd10pcs-omop.json` holds the OMOP concept ids of those ICD-10-PCS codes
(and the RxNorm concept a few drug-administration codes map to), taken from the
OHDSI Standardized Vocabularies downloaded from Athena (https://athena.ohdsi.org).
It holds identifiers only, no SNOMED CT content.

`src/data/procedure-terms-bg.json` holds words from the Bulgarian
Classification of Medical Procedures (КСМП, 2020, updated 17.02.2026), National
Centre of Public Health and Analyses (НЦОЗА, https://ncpha.government.bg),
which is based on the Australian Classification of Health Interventions (ACHI),
© Independent Health and Aged Care Pricing Authority (IHACPA). They are matched
to the groups through NCPHA's КСМП to ICD-9-CM correspondence table and the CMS
ICD-9-CM to ICD-10-PCS General Equivalence Mappings (FY2013, public domain).

## ICD-10 and NHIS nomenclatures

`src/data/icd10-synonyms.json` holds ICD-10-CM code descriptions (U.S. National
Center for Health Statistics, public domain), taken from the OHDSI Standardized
Vocabularies downloaded from Athena and filed under the WHO ICD-10 code each one
extends, as search words.

ICD-10 is © World Health Organization. Bulgarian ICD-10 titles, national
sub-codes and NHIS list codes (CL011, CL024) come from the nomenclatures of the
Bulgarian National Health Information System (НЗИС), Ministry of Health of the
Republic of Bulgaria, version 1.5.27 (https://www.his.bg).

## ATC

Drug data carries codes of the Anatomical Therapeutic Chemical (ATC)
classification, WHO Collaborating Centre for Drug Statistics Methodology
(https://atcddd.fhi.no).

## OMOP vocabularies and SNOMED CT

The OMOP standardized vocabularies are not part of this repository. Each site
downloads them from OHDSI Athena (https://athena.ohdsi.org) under the licences
Athena presents for each vocabulary, and imports them itself.

`src/data/lab-drug-omop.json` holds the OMOP concept ids of the LOINC codes LOSPOR
records and of the RxNorm ingredients the ATC codes of its catalogue and of its
Bulgarian drug list map to, from the same Athena download: identifiers only.

`src/data/icd10-omop.json` holds, for each ICD-10 code, the OMOP concept ids
Athena maps it to. These are integers assigned by OHDSI; the file contains no
SNOMED CT codes, names or descriptions.

The concept-map seed names a small number of SNOMED CT concept identifiers for
curated mappings. SNOMED CT® is a registered trademark of SNOMED International,
which licenses its use; in countries that are not SNOMED International members
an Affiliate Licence is required (https://www.snomed.org).
