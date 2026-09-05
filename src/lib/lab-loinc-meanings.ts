/**
 * What each seeded LOINC code actually names, verified against the Athena
 * vocabulary snapshot on 2026-09-05.
 *
 * This file exists because a code being standard, valid and Measurement-domain
 * says nothing about it being the right test. Fifteen of the sixty-six were
 * wrong when this was written: reticulocytes carried an antibiotic
 * susceptibility code, myoglobin carried CK-MB's, total bile acids carried
 * AST's, and nine analytes we store in SI units carried the mass-per-volume
 * form. None of it was visible in the app -- the screen showed the right name
 * and the right number, and only the exported concept was wrong, which is the
 * one thing nobody reads.
 *
 * Checked in rather than looked up so the test can run without the vocabulary,
 * which is gigabytes and not in any repository. It is a record of a decision,
 * not a source of truth: changing a code here without re-verifying it against
 * Athena defeats the point.
 */
export const LAB_LOINC_MEANINGS: Readonly<Record<string, readonly [code: string, conceptName: string]>> = Object.freeze({
  "Haemoglobin (Hb)": ["718-7", "Hemoglobin [Mass/volume] in Blood"],
  "Haematocrit (Hct)": ["4544-3", "Hematocrit [Volume Fraction] of Blood by Automated count"],
  "Erythrocytes (RBC)": ["789-8", "Erythrocytes [#/volume] in Blood by Automated count"],
  "Leucocytes (WBC)": ["6690-2", "Leukocytes [#/volume] in Blood by Automated count"],
  "Platelets": ["777-3", "Platelets [#/volume] in Blood by Automated count"],
  "MCV": ["787-2", "MCV [Entitic mean volume] in Red Blood Cells by Automated count"],
  "MCH": ["785-6", "MCH [Entitic mass] by Automated count"],
  "MCHC": ["786-4", "MCHC [Entitic Mass/volume] in Red Blood Cells by Automated count"],
  "Neutrophils": ["770-8", "Neutrophils/Leukocytes in Blood by Automated count"],
  "Lymphocytes": ["736-9", "Lymphocytes/Leukocytes in Blood by Automated count"],
  "Monocytes": ["5905-5", "Monocytes/Leukocytes in Blood by Automated count"],
  "Eosinophils": ["713-8", "Eosinophils/Leukocytes in Blood by Automated count"],
  "Reticulocytes": ["17849-1", "Reticulocytes/Erythrocytes in Blood by Automated count"],
  "PT (Prothrombin time)": ["5902-2", "Prothrombin time (PT)"],
  "INR": ["6301-6", "INR in Platelet poor plasma by Coagulation assay"],
  "aPTT": ["3173-2", "aPTT in Blood by Coagulation assay"],
  "Fibrinogen": ["3255-7", "Fibrinogen [Mass/volume] in Platelet poor plasma by Coagulation assay"],
  "D-dimer": ["48065-7", "Fibrin D-dimer FEU [Mass/volume] in Platelet poor plasma"],
  "Thrombin time (TT)": ["3243-3", "Thrombin time"],
  "Sodium (Na⁺)": ["2951-2", "Sodium [Moles/volume] in Serum or Plasma"],
  "Potassium (K⁺)": ["2823-3", "Potassium [Moles/volume] in Serum or Plasma"],
  "Chloride (Cl⁻)": ["2075-0", "Chloride [Moles/volume] in Serum or Plasma"],
  "Bicarbonate (HCO₃⁻)": ["1963-8", "Bicarbonate [Moles/volume] in Serum or Plasma"],
  "Calcium (Ca²⁺)": ["2000-8", "Calcium [Moles/volume] in Serum or Plasma"],
  "Ionised Ca²⁺": ["1994-3", "Calcium.ionized [Moles/volume] in Blood"],
  "Magnesium (Mg²⁺)": ["2601-3", "Magnesium [Moles/volume] in Serum or Plasma"],
  "Phosphate": ["14879-1", "Phosphate [Moles/volume] in Serum or Plasma"],
  "Creatinine": ["14682-9", "Creatinine [Moles/volume] in Serum or Plasma"],
  "eGFR": ["62238-1", "Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (CKD-EPI)/1.73 sq M"],
  "Urea (BUN)": ["22664-7", "Urea [Moles/volume] in Serum or Plasma"],
  "Glucose": ["14749-6", "Glucose [Moles/volume] in Serum or Plasma"],
  "HbA1c": ["4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood"],
  "Lactate": ["2524-7", "Lactate [Moles/volume] in Serum or Plasma"],
  "Uric acid": ["14933-6", "Urate [Moles/volume] in Serum or Plasma"],
  "Total protein": ["2885-2", "Protein [Mass/volume] in Serum or Plasma"],
  "Albumin": ["1751-7", "Albumin [Mass/volume] in Serum or Plasma"],
  "ALT (SGPT)": ["1742-6", "Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma"],
  "AST (SGOT)": ["1920-8", "Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma"],
  "ALP": ["6768-6", "Alkaline phosphatase [Enzymatic activity/volume] in Serum or Plasma"],
  "GGT": ["2324-2", "Gamma glutamyl transferase [Enzymatic activity/volume] in Serum or Plasma"],
  "Total bilirubin": ["14631-6", "Bilirubin.total [Moles/volume] in Serum or Plasma"],
  "Direct bilirubin": ["14629-0", "Bilirubin.direct [Moles/volume] in Serum or Plasma"],
  "Total bile acids": ["14628-2", "Bile acid [Moles/volume] in Serum or Plasma"],
  "Troponin I (hs-cTnI)": ["89579-7", "Troponin I.cardiac [Mass/volume] in Serum or Plasma by High sensitivity method"],
  "Troponin T (hs-cTnT)": ["67151-1", "Troponin T.cardiac [Mass/volume] in Serum or Plasma by High sensitivity method"],
  "CK (Creatine kinase)": ["2157-6", "Creatine kinase [Enzymatic activity/volume] in Serum or Plasma"],
  "CK-MB": ["32673-6", "Creatine kinase.MB [Enzymatic activity/volume] in Serum or Plasma"],
  "BNP": ["42637-9", "Natriuretic peptide B [Mass/volume] in Blood"],
  "NT-proBNP": ["33762-6", "Natriuretic peptide.B prohormone N-Terminal [Mass/volume] in Serum or Plasma"],
  "Myoglobin": ["2639-3", "Myoglobin [Mass/volume] in Serum or Plasma"],
  "pH": ["2744-1", "pH of Arterial blood"],
  "PaO₂": ["2703-7", "Oxygen [Partial pressure] in Arterial blood"],
  "PaCO₂": ["2019-8", "Carbon dioxide [Partial pressure] in Arterial blood"],
  "HCO₃⁻ (ABG)": ["1960-4", "Bicarbonate [Moles/volume] in Arterial blood"],
  "Base excess (BE)": ["1925-7", "Base excess in Arterial blood by calculation"],
  "SaO₂": ["2708-6", "Oxygen saturation in Arterial blood"],
  "Lactate (ABG)": ["2518-9", "Lactate [Moles/volume] in Arterial blood"],
  "TSH": ["3016-3", "Thyrotropin [Units/volume] in Serum or Plasma"],
  "Free T4 (fT4)": ["14920-3", "Thyroxine (T4) free [Moles/volume] in Serum or Plasma"],
  "Free T3 (fT3)": ["14928-6", "Triiodothyronine (T3) Free [Moles/volume] in Serum or Plasma"],
  "CRP": ["1988-5", "C reactive protein [Mass/volume] in Serum or Plasma"],
  "ESR": ["4537-7", "Erythrocyte sedimentation rate [Velocity] in Red Blood Cells by Westergren method"],
  "Ferritin": ["2276-4", "Ferritin [Mass/volume] in Serum or Plasma"],
  "Procalcitonin (PCT)": ["75241-0", "Procalcitonin [Mass/volume] in Serum or Plasma by Immunoassay"],
  "IL-6": ["26881-3", "Interleukin 6 [Mass/volume] in Serum or Plasma"],
})
