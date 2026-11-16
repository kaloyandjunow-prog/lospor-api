/**
 * LOSPOR's own OMOP vocabulary (exchange contract 2.9.0).
 *
 * Some of what an anaesthetic record holds has no concept anywhere in the OHDSI
 * vocabularies: the Aldrete items one by one, Apfel, POVOC, COLDS, the Steward
 * and PAED scales, a TCI model, the strength of a syringe. Until 2.9.0 those rows
 * left as concept 0 -- "nowhere standard to put this" -- and a researcher saw a
 * column of zeros with only the source value to go by.
 *
 * OHDSI's convention for a site's own codes is a concept id at or above
 * 2,000,000,000, in a vocabulary of its own. That is what this is: each row a
 * concept with a name, a domain and a class, published as a CONCEPT table
 * (`losporVocabularyConceptRows`) so it loads beside the OHDSI vocabularies.
 *
 * Ids are permanent. A concept, once published, keeps its id forever -- research
 * databases hold it -- so a code that leaves the export keeps its row here marked
 * `retired`, and a new code takes the next free id. Never renumber, never reuse;
 * the test pins every id.
 *
 * A row is only for something the vocabularies do not have. Where a standard
 * concept exists the mapper uses it, and this table must not shadow it.
 */

export const LOSPOR_VOCABULARY_ID = "LOSPOR"
export const LOSPOR_VOCABULARY_VERSION = "2026-11-15"

export type LosporConcept = {
  conceptId: number
  /** The observation/measurement source value it names; `source=value` for one answer of a selection. */
  code: string
  name: string
  domain: "Observation" | "Measurement"
  conceptClass: "Clinical Observation" | "Staging / Scales" | "Observable Entity"
  retired?: true
}

const c = (conceptId: number, code: string, name: string, domain: LosporConcept["domain"] = "Observation",
  conceptClass: LosporConcept["conceptClass"] = "Clinical Observation"): LosporConcept =>
  ({ conceptId, code, name, domain, conceptClass })

export const LOSPOR_CONCEPTS: readonly LosporConcept[] = Object.freeze([
  // Airway
  c(2000000001, "LOSPOR:LMA_SIZE", "Laryngeal mask airway size"),
  c(2000000002, "LOSPOR:DLT_TYPE", "Double-lumen tube type"),
  c(2000000003, "LOSPOR:DLT_SIDE", "Double-lumen tube side"),
  c(2000000004, "LOSPOR:DLT_SIZE", "Double-lumen tube size"),
  c(2000000005, "LOSPOR:ENDOBRONCHIAL_TUBE_SIZE", "Endobronchial tube size"),
  c(2000000006, "LOSPOR:DIFFICULT_AIRWAY_NOTES", "Difficult airway note"),
  c(2000000007, "LOSPOR:UPPER_LIP_BITE_TEST", "Upper lip bite test class", "Observation", "Staging / Scales"),
  c(2000000008, "LOSPOR:FACIAL_HAIR", "Facial hair present"),
  // Gases
  c(2000000009, "LOSPOR:CARRIER_GAS", "Carrier gas"),
  c(2000000010, "LOSPOR:FIAIR_PERCENT", "Fraction of inspired air", "Measurement"),
  // Fluids and blood
  c(2000000011, "LOSPOR:CRYSTALLOIDS_ML", "Intraoperative crystalloid volume, case total"),
  c(2000000012, "LOSPOR:COLLOIDS_ML", "Intraoperative colloid volume, case total"),
  c(2000000013, "LOSPOR:BLOOD_PRODUCTS_ML", "Intraoperative blood product volume, case total"),
  c(2000000014, "LOSPOR:DRUG_INFUSIONS_ML", "Intraoperative drug infusion volume, case total"),
  c(2000000015, "LOSPOR:BLOOD_PRODUCT_UNIT_ML", "Blood product unit volume"),
  // Infusions, TCI and how a drug was given
  c(2000000016, "LOSPOR:INFUSION_PUMP_RATE_ML_PER_HOUR", "Infusion pump rate"),
  c(2000000017, "LOSPOR:INFUSION_STRENGTH", "Infusion syringe strength"),
  c(2000000018, "LOSPOR:TCI_MODEL", "Target-controlled infusion model"),
  c(2000000019, "LOSPOR:TCI_SITE", "Target-controlled infusion target site"),
  c(2000000020, "LOSPOR:TCI_WITH_OPIOIDS", "Target-controlled infusion with opioid interaction"),
  c(2000000021, "LOSPOR:TCI_TARGET", "Target-controlled infusion target concentration"),
  c(2000000022, "LOSPOR:TCI_TOTAL_CALCULATED", "Target-controlled infusion total dose, calculated"),
  c(2000000023, "LOSPOR:TCI_TOTAL_PUMP", "Target-controlled infusion total dose, from the pump"),
  c(2000000024, "LOSPOR:TCI_TOTAL_PUMP_ML", "Target-controlled infusion total volume, from the pump"),
  c(2000000025, "LOSPOR:DRUG_CONCENTRATION", "Drug concentration as given"),
  c(2000000026, "LOSPOR:DRUG_FORMULATION", "Drug formulation baricity"),
  c(2000000027, "LOSPOR:DOSE_CALCULATION_WEIGHT_KG", "Weight used for dose calculation", "Measurement"),
  c(2000000028, "LOSPOR:PREMEDICATION_PHASE", "Premedication phase"),
  c(2000000029, "LOSPOR:PREMEDICATION_ORDER_PHASE", "Premedication order phase"),
  // Vascular access
  c(2000000030, "LOSPOR:VASCULAR_ACCESS_DEPTH_CM", "Vascular access insertion depth"),
  c(2000000031, "LOSPOR:VASCULAR_ACCESS_LUMENS", "Vascular access lumen count"),
  c(2000000032, "LOSPOR:VASCULAR_ACCESS_PREEXISTING", "Vascular access present on arrival"),
  c(2000000033, "LOSPOR:VASCULAR_ACCESS_FAILED", "Vascular access attempt failed"),
  // Monitoring modalities the vocabularies name only as the value measured
  c(2000000034, "LOSPOR:INTRAOP_MONITORING=bis", "Bispectral index monitoring"),
  c(2000000035, "LOSPOR:INTRAOP_MONITORING=entropyMonitor", "Spectral entropy monitoring"),
  c(2000000036, "LOSPOR:INTRAOP_MONITORING=etco2Monitor", "End-tidal carbon dioxide monitoring"),
  // Recovery scales
  c(2000000037, "LOSPOR:ALDRETE_ACTIVITY", "Aldrete activity score", "Observation", "Staging / Scales"),
  c(2000000038, "LOSPOR:ALDRETE_RESPIRATION", "Aldrete respiration score", "Observation", "Staging / Scales"),
  c(2000000039, "LOSPOR:ALDRETE_CIRCULATION", "Aldrete circulation score", "Observation", "Staging / Scales"),
  c(2000000040, "LOSPOR:ALDRETE_CONSCIOUSNESS", "Aldrete consciousness score", "Observation", "Staging / Scales"),
  c(2000000041, "LOSPOR:ALDRETE_SPO2", "Aldrete oxygen saturation score", "Observation", "Staging / Scales"),
  c(2000000042, "LOSPOR:STEWARD_CONSCIOUSNESS", "Steward consciousness score", "Observation", "Staging / Scales"),
  c(2000000043, "LOSPOR:STEWARD_AIRWAY", "Steward airway score", "Observation", "Staging / Scales"),
  c(2000000044, "LOSPOR:STEWARD_MOVEMENT", "Steward movement score", "Observation", "Staging / Scales"),
  c(2000000045, "LOSPOR:STEWARD_TOTAL", "Steward recovery score", "Observation", "Staging / Scales"),
  c(2000000046, "LOSPOR:PAED_SCORE", "Pediatric Anesthesia Emergence Delirium score", "Observation", "Staging / Scales"),
  c(2000000047, "LOSPOR:PAED_EYE_CONTACT", "PAED eye contact item", "Observation", "Staging / Scales"),
  c(2000000048, "LOSPOR:PAED_PURPOSEFUL", "PAED purposeful actions item", "Observation", "Staging / Scales"),
  c(2000000049, "LOSPOR:PAED_AWARE", "PAED awareness of surroundings item", "Observation", "Staging / Scales"),
  c(2000000050, "LOSPOR:PAED_RESTLESS", "PAED restlessness item", "Observation", "Staging / Scales"),
  c(2000000051, "LOSPOR:PAED_INCONSOLABLE", "PAED inconsolability item", "Observation", "Staging / Scales"),
  c(2000000052, "LOSPOR:NIPS_FACIAL_EXPRESSION", "NIPS facial expression item", "Observation", "Staging / Scales"),
  c(2000000053, "LOSPOR:NIPS_CRY", "NIPS cry item", "Observation", "Staging / Scales"),
  c(2000000054, "LOSPOR:NIPS_BREATHING", "NIPS breathing pattern item", "Observation", "Staging / Scales"),
  c(2000000055, "LOSPOR:NIPS_ARMS", "NIPS arms item", "Observation", "Staging / Scales"),
  c(2000000056, "LOSPOR:NIPS_LEGS", "NIPS legs item", "Observation", "Staging / Scales"),
  c(2000000057, "LOSPOR:NIPS_AROUSAL", "NIPS state of arousal item", "Observation", "Staging / Scales"),
  // Preoperative risk
  c(2000000058, "LOSPOR:APFEL", "Apfel postoperative nausea and vomiting risk score", "Observation", "Staging / Scales"),
  c(2000000059, "LOSPOR:POVOC_SCORE", "Postoperative vomiting in children score", "Observation", "Staging / Scales"),
  c(2000000060, "LOSPOR:POVOC_RISK_PERCENT", "Postoperative vomiting in children risk"),
  c(2000000061, "LOSPOR:POVOC_AGE_3_YEARS", "POVOC age 3 years or older"),
  c(2000000062, "LOSPOR:COLDS_SCORE", "COLDS respiratory risk score", "Observation", "Staging / Scales"),
  c(2000000063, "LOSPOR:COLDS_CURRENT_SYMPTOMS", "COLDS current symptoms item", "Observation", "Staging / Scales"),
  c(2000000064, "LOSPOR:COLDS_ONSET", "COLDS onset of symptoms item", "Observation", "Staging / Scales"),
  c(2000000065, "LOSPOR:COLDS_LUNG_DISEASE", "COLDS lung disease item", "Observation", "Staging / Scales"),
  c(2000000066, "LOSPOR:COLDS_AIRWAY_DEVICE", "COLDS airway device item", "Observation", "Staging / Scales"),
  c(2000000067, "LOSPOR:COLDS_SURGERY", "COLDS surgery item", "Observation", "Staging / Scales"),
  c(2000000068, "LOSPOR:GUPTA_MICA_RISK_PERCENT", "Gupta perioperative myocardial infarction or cardiac arrest risk"),
  c(2000000069, "LOSPOR:PEDIATRIC_NPO_HOURS", "Pediatric preoperative fasting time"),
  c(2000000070, "LOSPOR:FAMILY_ANAESTHESIA_DETAILS", "Family history of anaesthetic problems, details"),
  c(2000000071, "LOSPOR:ALLERGY_DETAILS", "Allergy details"),
  c(2000000072, "LOSPOR:LAB_ABNORMAL_FLAG", "Laboratory abnormal flag"),
  // Complication notes
  c(2000000073, "LOSPOR:PREOP_COMPLICATION_NOTE", "Preoperative complication note"),
  c(2000000074, "LOSPOR:INTRAOP_COMPLICATION_NOTE", "Intraoperative complication note"),
  c(2000000075, "LOSPOR:POSTOP_COMPLICATION_NOTE", "Postoperative complication note"),
  c(2000000076, "LOSPOR:DEFIBRILLATION_ENERGY_J", "Defibrillation energy delivered", "Measurement"),
])

const BY_CODE = new Map(LOSPOR_CONCEPTS.filter(row => !row.retired).map(row => [row.code, row.conceptId]))

/**
 * The code a row is looked up by. Several sources carry a variable part that is
 * not a different idea: the fasting category, the line that failed, the shock.
 */
function codeOf(source: string): string {
  if (/^LOSPOR:PEDIATRIC_NPO_.+_HOURS$/.test(source)) return "LOSPOR:PEDIATRIC_NPO_HOURS"
  if (/^VASCULAR_ACCESS:.+:failed$/.test(source)) return "LOSPOR:VASCULAR_ACCESS_FAILED"
  if (/^INTRAOP_EVENT:(Defibrillation|Cardioversion):energy$/.test(source)) return "LOSPOR:DEFIBRILLATION_ENERGY_J"
  return source
}

/** LOSPOR's concept for a source value (and, for a selection, its answer); 0 when it has none. */
export function losporConceptId(source: string | null | undefined, value?: string | null): number {
  if (!source) return 0
  const code = codeOf(source)
  return (value != null ? BY_CODE.get(`${code}=${value}`) : undefined) ?? BY_CODE.get(code) ?? 0
}

/** The vocabulary as OMOP CONCEPT rows, to load beside the OHDSI vocabularies. */
export function losporVocabularyConceptRows() {
  return LOSPOR_CONCEPTS.map(row => ({
    concept_id: row.conceptId,
    concept_name: row.name,
    domain_id: row.domain,
    vocabulary_id: LOSPOR_VOCABULARY_ID,
    concept_class_id: row.conceptClass,
    standard_concept: row.retired ? null : "S",
    concept_code: row.code,
    valid_start_date: "2026-11-15",
    valid_end_date: row.retired ? "2026-11-15" : "2099-12-31",
    invalid_reason: row.retired ? "D" : null,
  }))
}
