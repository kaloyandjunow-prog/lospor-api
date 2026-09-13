/**
 * The 50 NHIS CL024 keys approved in the LOSPOR 66-test clinical review.
 * Source labels are from NHIS 1.5.27; target LOINCs were checked against
 * Athena LOINC 2.80. A null LOINC is an intentional source-only decision.
 */
export type NhisCl024LabConceptMap = {
  sourceCode: string
  sourceLabelEn: string
  sourceLabelBg: string
  loincCode: string | null
  relationship: "exact" | "reviewed-crosswalk" | "accepted-alternative" | "source-only"
}

export const NHIS_CL024_LAB_CONCEPT_MAPS: readonly NhisCl024LabConceptMap[] = [
  { sourceCode: "01-000-02", sourceLabelEn: "Hemoglobin (HGB)", sourceLabelBg: "Изследвания на кръв - Хемоглобин (HGB)", loincCode: "718-7", relationship: "exact" },
  { sourceCode: "01-000-03", sourceLabelEn: "Hematocrit (HCT)", sourceLabelBg: "Изследвания на кръв - Хематокрит (HCT)", loincCode: "20570-8", relationship: "accepted-alternative" },
  { sourceCode: "01-000-01", sourceLabelEn: "Erythrocytes (RBC)", sourceLabelBg: "Изследвания на кръв - Еритроцити (RBC)", loincCode: "26453-1", relationship: "accepted-alternative" },
  { sourceCode: "01-000-00", sourceLabelEn: "Leukocytes (WBC)", sourceLabelBg: "Изследвания на кръв - Левкоцити (WBC)", loincCode: "26464-8", relationship: "accepted-alternative" },
  { sourceCode: "01-000-0D", sourceLabelEn: "Platelets (PLT)", sourceLabelBg: "Изследвания на кръв - Tромбоцити (PLT)", loincCode: "26515-7", relationship: "accepted-alternative" },
  { sourceCode: "01-000-04", sourceLabelEn: "Mean corpuscular volume (MCV)", sourceLabelBg: "Изследвания на кръв - Среден обем на еритроцитите (MCV)", loincCode: "30428-7", relationship: "accepted-alternative" },
  { sourceCode: "01-000-05", sourceLabelEn: "Mean corpuscular hemoglobin (MCH)", sourceLabelBg: "Изследвания на кръв - Средно съдържание на хемоглобин в еритроцита (MCH)", loincCode: "28539-5", relationship: "accepted-alternative" },
  { sourceCode: "01-000-06", sourceLabelEn: "Mean corpuscular hemoglobin concentration (MCHC)", sourceLabelBg: "Изследвания на кръв - Средна концентрация на хемоглобин в еритроцитите (MCHC)", loincCode: "28540-3", relationship: "accepted-alternative" },
  { sourceCode: "01-001-07", sourceLabelEn: "Neutrophils / 100 Leukocytes", sourceLabelBg: "Изследвания на кръв - Неутрофили, %", loincCode: "26511-6", relationship: "accepted-alternative" },
  { sourceCode: "01-001-06", sourceLabelEn: "Lymphocytes / 100 Leukocytes", sourceLabelBg: "Изследвания на кръв - Лимфоцити, %", loincCode: "26478-8", relationship: "accepted-alternative" },
  { sourceCode: "01-001-02", sourceLabelEn: "Monocytes / 100 Leukocytes", sourceLabelBg: "Изследвания на кръв - Моноцити, %", loincCode: "26485-3", relationship: "accepted-alternative" },
  { sourceCode: "01-001-05", sourceLabelEn: "Eosinophils / 100 Leukocytes", sourceLabelBg: "Изследвания на кръв - Еозинофили, %", loincCode: "26450-7", relationship: "accepted-alternative" },
  { sourceCode: "01-00F-01", sourceLabelEn: "Reticulocytes / 100 Erythrocytes", sourceLabelBg: "Изследване на ретикулоцити, % (RET)", loincCode: "4679-7", relationship: "accepted-alternative" },
  { sourceCode: "01-010-00", sourceLabelEn: "Prothrombin time (PT), s", sourceLabelBg: "Изследване на протромбиново време в секунди (PT)", loincCode: "5902-2", relationship: "exact" },
  { sourceCode: "01-010-01", sourceLabelEn: "Prothrombin time (PT), INR", sourceLabelBg: "Изследване на протромбиново време чрез INR (PT)", loincCode: "6301-6", relationship: "exact" },
  { sourceCode: "01-008-00", sourceLabelEn: "Activated partial thromboplastin time (APTT)", sourceLabelBg: "Изследване на активирано парциално тромбопластиново време (APTT)", loincCode: "3173-2", relationship: "exact" },
  { sourceCode: "01-009-00", sourceLabelEn: "Fibrinogen", sourceLabelBg: "Изследване на фибриноген", loincCode: "97016-0", relationship: "accepted-alternative" },
  { sourceCode: "00-00E-00", sourceLabelEn: "D-dimer test", sourceLabelBg: "Изследване на D – димер тест", loincCode: null, relationship: "source-only" },
  { sourceCode: "01-007-00", sourceLabelEn: "Thrombin time (TT)", sourceLabelBg: "Изследване на тромбиново време в секунди (TT)", loincCode: "3243-3", relationship: "exact" },
  { sourceCode: "03-019-00", sourceLabelEn: "Clinical chemistry test for sodium", sourceLabelBg: "Клинично-химични изследвания за натрий", loincCode: "2951-2", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-019-01", sourceLabelEn: "Clinical chemistry test for potassium", sourceLabelBg: "Клинично-химични изследвания за калий", loincCode: "2823-3", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-01E-00", sourceLabelEn: "Clinical chemistry test for chlorides", sourceLabelBg: "Клинично-химични изследвания за хлориди", loincCode: "2075-0", relationship: "exact" },
  { sourceCode: "03-01A-00", sourceLabelEn: "Clinical chemistry test for calcium", sourceLabelBg: "Клинично-химични изследвания за калций", loincCode: "2000-8", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-01F-00", sourceLabelEn: "Clinical chemistry test for magnesium", sourceLabelBg: "Клинично-химични изследвания за магнезий", loincCode: "2601-3", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-01B-00", sourceLabelEn: "Clinical chemistry test for phosphates", sourceLabelBg: "Клинично-химични изследвания за фосфати", loincCode: "14879-1", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-003-00", sourceLabelEn: "Clinical chemistry test for creatinine", sourceLabelBg: "Клинично-химични изследвания за креатинин", loincCode: "14682-9", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-029-00", sourceLabelEn: "Results for Estimated Glomerular Filtration Rate - eGFR", sourceLabelBg: "Изчислена гломерулна филтрация (eGFR)", loincCode: "98979-8", relationship: "accepted-alternative" },
  { sourceCode: "03-004-00", sourceLabelEn: "Clinical chemistry test for urea", sourceLabelBg: "Клинично-химични изследвания за урея", loincCode: "22664-7", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-002-00", sourceLabelEn: "Clinical chemistry test for glucose", sourceLabelBg: "Клинично-химични изследвания за глюкоза", loincCode: "14749-6", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-010-00", sourceLabelEn: "Clinical chemistry test for glycated hemoglobin (HbA1c)", sourceLabelBg: "Клинично-химични изследвания за гликиран хемоглобин", loincCode: "4548-4", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-011-00", sourceLabelEn: "Clinical chemistry test for uric acid", sourceLabelBg: "Клинично-химични изследвания за пикочна киселина", loincCode: "14933-6", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-007-00", sourceLabelEn: "Clinical chemistry test for total protein", sourceLabelBg: "Клинично-химични изследвания за общ белтък", loincCode: "2885-2", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-008-00", sourceLabelEn: "Clinical chemistry test for albumin", sourceLabelBg: "Клинично-химични изследвания за албумин", loincCode: "1751-7", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-013-00", sourceLabelEn: "Clinical chemistry test for ALAT (ALT)", sourceLabelBg: "Клинично-химични изследвания за АЛАТ", loincCode: "1742-6", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-012-00", sourceLabelEn: "Clinical chemistry test for ASAT (AST)", sourceLabelBg: "Клинично-химични изследвания за AСАТ", loincCode: "1920-8", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-016-00", sourceLabelEn: "Clinical chemistry test for alkaline phosphatase (ALP)", sourceLabelBg: "Клинично-химични изследвания за алкална фосфатаза (АФ)", loincCode: "6768-6", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-015-00", sourceLabelEn: "Clinical chemistry test for GGT", sourceLabelBg: "Клинично-химични изследвания за ГГТ", loincCode: "2324-2", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-005-00", sourceLabelEn: "Clinical chemistry test for total bilirubin", sourceLabelBg: "Клинично-химични изследвания за общ билирубин", loincCode: "14631-6", relationship: "reviewed-crosswalk" },
  { sourceCode: "03-006-00", sourceLabelEn: "Clinical chemistry test for direct bilirubin", sourceLabelBg: "Клинично-химични изследвания за директен билирубин", loincCode: "14629-0", relationship: "reviewed-crosswalk" },
  { sourceCode: "00-00C-00", sourceLabelEn: "Troponin I (cTnI)", sourceLabelBg: "Изследване на тропонин I (cTnI)", loincCode: null, relationship: "source-only" },
  { sourceCode: "00-02D-00", sourceLabelEn: "Cardiac troponin T (cTnT)", sourceLabelBg: "Изследване на сърдечен тропонин (cTnT)", loincCode: null, relationship: "source-only" },
  { sourceCode: "03-014-00", sourceLabelEn: "Clinical chemistry test for creatine kinase (CK)", sourceLabelBg: "Клинично-химични изследвания за креатинкиназа (КК)", loincCode: "2157-6", relationship: "reviewed-crosswalk" },
  { sourceCode: "00-00B-00", sourceLabelEn: "Examination of CK-MB (MB fraction of creatine kinase)", sourceLabelBg: "Изследване на МВ фракция на креатинкиназа", loincCode: null, relationship: "source-only" },
  { sourceCode: "00-02B-00", sourceLabelEn: "B-type Natriuretic Peptide (BNP)", sourceLabelBg: "Изследване на натриуретричен пептид (BNP)", loincCode: "42637-9", relationship: "reviewed-crosswalk" },
  { sourceCode: "00-02C-00", sourceLabelEn: "Aminoterminal pro B-type natriuretic peptide (NT-pro BNP)", sourceLabelBg: "Изследване на фрагмент на прохормона на натриуретичен пептид (NT-pro BNP)", loincCode: "33762-6", relationship: "reviewed-crosswalk" },
  { sourceCode: "08-002-00", sourceLabelEn: "Test for hormone TSH", sourceLabelBg: "Изследване на хормон TSH", loincCode: "3016-3", relationship: "exact" },
  { sourceCode: "03-00A-00", sourceLabelEn: "C-reactive protein (CRP)", sourceLabelBg: "Клинично-химични изследвания за С-реактивен протеин", loincCode: "1988-5", relationship: "reviewed-crosswalk" },
  { sourceCode: "01-003-00", sourceLabelEn: "Erythrocyte sedimentation rate (ESR)", sourceLabelBg: "Определяне на скорост на утаяване на еритроцитите", loincCode: "30341-2", relationship: "accepted-alternative" },
  { sourceCode: "03-021-00", sourceLabelEn: "Ferritin", sourceLabelBg: "Определяне на феритин", loincCode: "2276-4", relationship: "exact" },
  { sourceCode: "08-012-00", sourceLabelEn: "Test for Procalcitonin (PCT)", sourceLabelBg: "Изследване на Прокалцитонин (PCT)", loincCode: "33959-8", relationship: "accepted-alternative" },
]

