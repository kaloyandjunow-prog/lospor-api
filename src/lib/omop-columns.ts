import type { OmopBundle } from "@/lib/omop-mapper"

/**
 * Derived from the mapper's own bundle rather than a hand-written list, so a
 * table the mapper starts emitting cannot be missing here. The appliance's
 * exchange contract declares the same names for Central; this stays independent
 * of it so the definition works in both repos.
 */
export type OmopTableName = Exclude<keyof OmopBundle, "metadata">

/**
 * The OMOP CSV column set, per table, in CDM v5.4 column order.
 *
 * One definition, imported by every serializer. There used to be one list per
 * writer, and they drifted: OBSERVATION gained `value_as_number`, the research
 * export was corrected, and the Central export was not — so roughly two dozen
 * clinical scores reached Central without their numbers for a release, with
 * correct row counts and a parseable header the whole time.
 *
 * A field the mapper emits but this list omits is written nowhere and raises no
 * error, which is why the column tests hold this list against the mapper's
 * actual output rather than trusting it. Adding a field here is the single
 * place that has to change.
 */
export const OMOP_COLUMNS: Record<OmopTableName, readonly string[]> = {
  care_site: [
    "care_site_id", "care_site_name", "place_of_service_concept_id",
    "care_site_source_value",
  ],
  person: [
    "person_id", "gender_concept_id", "year_of_birth", "month_of_birth", "day_of_birth",
    "birth_datetime", "race_concept_id", "ethnicity_concept_id", "person_source_value",
    "gender_source_value",
  ],
  observation_period: [
    "observation_period_id", "person_id", "observation_period_start_date",
    "observation_period_end_date", "period_type_concept_id",
  ],
  visit_occurrence: [
    "visit_occurrence_id", "person_id", "visit_concept_id", "visit_start_date", "visit_end_date",
    "visit_type_concept_id", "visit_source_value", "care_site_source_value", "care_site_id",
  ],
  condition_occurrence: [
    "condition_occurrence_id", "person_id", "condition_concept_id", "condition_start_date",
    "condition_type_concept_id", "condition_source_value", "visit_occurrence_id",
  ],
  drug_exposure: [
    "drug_exposure_id", "person_id", "drug_concept_id", "drug_exposure_start_date", "drug_exposure_end_date",
    "drug_type_concept_id", "drug_source_value", "drug_source_concept_id", "dose_value",
    "dose_unit_source_value", "route_source_value", "visit_occurrence_id",
  ],
  measurement: [
    "measurement_id", "person_id", "measurement_concept_id", "measurement_date",
    "measurement_datetime", "measurement_type_concept_id", "value_as_number", "value_as_concept_id", "unit_concept_id",
    "unit_source_value", "measurement_source_value", "value_source_value",
    "range_low", "range_high", "visit_occurrence_id",
  ],
  procedure_occurrence: [
    "procedure_occurrence_id", "person_id", "procedure_concept_id", "procedure_date",
    "procedure_type_concept_id",
    // How the operation was performed — urgency, for now. A qualifier on the
    // operation rather than an operation of its own, which is what keeps one
    // appendectomy counting as one procedure.
    "modifier_concept_id", "modifier_source_value",
    "procedure_source_value", "visit_occurrence_id",
  ],
  observation: [
    "observation_id", "person_id", "observation_concept_id", "observation_date",
    "observation_type_concept_id", "value_as_number", "value_as_string",
    // A coded answer where the vocabulary can state one -- a clinical yes or no
    // that no tool can read out of the string "true".
    "value_as_concept_id",
    "observation_source_value", "visit_occurrence_id",
  ],
}
