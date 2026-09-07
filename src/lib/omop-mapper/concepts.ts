import { TECHNIQUE_TREE } from "@lospor/core/catalog"
import type { TreeNode } from "@lospor/core/catalog"

/**
 * OMOP concept maps for the mapper, split out of omop-mapper.ts.
 *
 * This is reference data: source code -> standard concept id, one table per
 * clinical axis (airway, technique, vascular access, ventilation, vitals,
 * labs, blood group, ASA, graded scales). None of it depends on a case being
 * mapped, which is what makes it safe to pull out of the per-case loop and
 * verify -- and extend -- on its own.
 */

/**
 * The act of placing each airway device, where placing it is a procedure.
 *
 * A device is a state of the patient; putting it there is something done to
 * them, and only the second belongs in a procedure count. Devices that are
 * applied rather than instrumented map to null: a face mask is held on a face,
 * and counting that as an airway procedure would inflate every such count.
 *
 * Exhaustive over `AIRWAY_DEVICES` in @lospor/core, and asserted so by test.
 * The list is seeded from that catalogue and can grow, and a device missing
 * from here would silently export no procedure at all -- the failure would be
 * an absence, which nothing else in the pipeline would notice.
 */
export const AIRWAY_ACTS: Record<string, string | null> = {
  FACE_MASK:          null,
  OPA:                null,
  NPA:                null,
  LMA:                "SUPRAGLOTTIC_AIRWAY_PLACEMENT",
  ORAL_ETT:           "TRACHEAL_INTUBATION_ORAL",
  NASAL_ETT:          "TRACHEAL_INTUBATION_NASAL",
  DOUBLE_LUMEN_TUBE:  "DOUBLE_LUMEN_TUBE_PLACEMENT",
  ENDOBRONCHIAL_TUBE: "ENDOBRONCHIAL_TUBE_PLACEMENT",
  SURGICAL_AIRWAY:    "SURGICAL_AIRWAY",
}

/**
 * The device itself, for DEVICE_EXPOSURE.
 *
 * Distinct from AIRWAY_ACTS above, which is the act of placing one. A face
 * mask and the oral and nasal airways produce no procedure -- nothing is
 * instrumented -- but they are still devices that were in the patient, so
 * unlike the act map this one has no nulls to skip.
 *
 * SURGICAL_AIRWAY has no device concept: the vocabulary names the
 * cricothyroidotomy procedure and the cannula used for it separately, and
 * which was used is not recorded, so it stays 0 rather than guessing.
 */
export const AIRWAY_DEVICE_CONCEPTS: Record<string, number> = {
  FACE_MASK:          4126216,
  OPA:                4139134,
  NPA:                4266238,
  LMA:                4106029,
  ORAL_ETT:           4097216,
  NASAL_ETT:          4097216,
  DOUBLE_LUMEN_TUBE:  4161796,
  ENDOBRONCHIAL_TUBE: 4161796,
  SURGICAL_AIRWAY:    0,
}

/** Laryngoscopy and intubation aids, for DEVICE_EXPOSURE. */
export const AIRWAY_TOOL_CONCEPTS: Record<string, number> = {
  VIDEO_LARY:  40492457,
  DIRECT_LARY: 4106016,
  FOB:         4220610,
  BOUGIE:      4094381,
  // STYLET, AWAKE, RETROGRADE and SUPRAGLOTTIC have no device concept: the
  // last three are techniques rather than instruments, and a stylet is not
  // separately named. They stay source values.
  STYLET:      0,
  AWAKE:       0,
  RETROGRADE:  0,
  SUPRAGLOTTIC: 0,
}

// ─── What anaesthetic was given ──────────────────────────────────────────────
//
// The technique tree is about a hundred nodes deep — GENERAL to GENERAL_TIVA,
// SPINAL to SPINAL_SINGLE to SPINAL_SINGLE_LUMBAR — and the vocabulary is not
// that granular in the same shape. So a concept is attached at the level where
// one honestly exists, and any node below it inherits from its nearest mapped
// ancestor: SPINAL_SINGLE_LUMBAR exports as spinal anaesthesia.
//
// Nothing is lost by that. procedure_source_value still carries the exact node
// the anaesthetist chose, so "single shot, lumbar" survives as recorded rather
// than being flattened away or coded as something SNOMED does not actually say.
// Filling in a deeper node later is one line here and changes no stored data.
export const TECHNIQUE_CONCEPTS: Record<string, number> = {
  // There is no plain "General anesthesia" procedure concept in this
  // vocabulary. The ones that exist are CIEL, MeSH, SUS and NDFRT, none of
  // which ship here, so this is the umbrella available to us — and it says what
  // is meant: general anaesthesia for an operation.
  // "Administration of general anesthetic" rather than "Operative general
  // anesthesia" (4171773). The two look interchangeable and are not: 4171773 is
  // a sibling of GENERAL_INHALATION and GENERAL_TIVA under this concept, not
  // their ancestor, so a cohort built on 4171773 + descendants would miss every
  // inhalational and every TIVA case -- the opposite of what a "general
  // anaesthetic" filter should do. 4174669 is the true parent of all three,
  // verified against CONCEPT_ANCESTOR, and its descendant set stops at general
  // anaesthesia: sedation sits elsewhere, under 4249997, so this does not widen
  // into sedation cases.
  GENERAL:  4174669,
  // The three children split on what maintained the anaesthetic, which is the
  // axis research asks about: volatile only, intravenous only, or both.
  GENERAL_INHALATION: 4118897,
  GENERAL_TIVA:       4086418,
  // Balanced is stated here rather than left to inherit, so it reads as a
  // decision and not as a node nobody reached.
  //
  // There is no concept for it, and that gap is the right shape. Neither
  // sibling is true of a balanced anaesthetic: TIVA means *total* intravenous,
  // so a case running sevoflurane is not TIVA, and it is not inhalation-only
  // either. The parent is the correct answer, not a fallback -- do not "fix"
  // this later by picking one of the other two.
  //
  // The drug rows answer this better than any technique code can in any case.
  // Sevoflurane and propofol both appear on the case with start and stop times,
  // so the maintenance route is visible directly, including the case that began
  // volatile and switched to TIVA, which no single code expresses.
  GENERAL_BALANCED:   4171773,
  SPINAL:   4332593,
  EPIDURAL: 4078199,
  // Not "Conscious sedation", which asserts the patient stayed rousable. MAC
  // covers a range that reaches deep sedation, so that would be false for some
  // cases; this is true of all of them. The exact term, CIEL's "Monitored
  // anesthesia care", is not in this vocabulary.
  SEDATION: 4219502,
  // Not 4303995 (Local anesthesia), which looked like the obvious umbrella and
  // is verified, against CONCEPT_ANCESTOR, as the parent of the entire nerve
  // block family too -- using it here would give a plain wound infiltration
  // the same lineage as a spinal or a TAP block, the same shape of problem as
  // REGIONAL. This names what the node actually means: infiltrating the wound
  // for a case done under local alone.
  LOCAL: 4124873,
  // The block hierarchy. SNOMED has a "Local anesthetic nerve block in
  // <region>" family that mirrors this part of the tree almost exactly, so four
  // nodes cover roughly forty leaves truthfully, and each leaf can be refined
  // later without touching a stored value.
  PERIPHERAL:  4140397,
  BLOCK_UPPER: 4332443,
  BLOCK_LOWER: 4333960,
  // Trunk rather than abdomen. TAP and rectus sheath are abdominal, but ESP,
  // serratus, PECS, paravertebral and intercostal are thoracic, and this node
  // holds both.
  BLOCK_TRUNK:     4125199,
  BLOCK_HEAD_NECK: 4125198,

  // The first named leaves, refining their region umbrellas.
  //
  // The core SNOMED concept rather than the UK national extension
  // (44808433, same procedure, code 830001000000106): 44783705 is portable
  // and matches the naming convention of every other block mapped here.
  BLOCK_TAP:      44783705,
  BLOCK_FEMORAL:  4336456,
  // No "adductor canal block" procedure concept exists in any vocabulary here
  // -- only anatomy and a syndrome. This is not an approximation of
  // convenience: the adductor canal block is a saphenous nerve block done at
  // that level, and the saphenous nerve is what it anaesthetises.
  BLOCK_ADDUCTOR: 4333280,
  BLOCK_INTERSCALENE:    4333843,
  BLOCK_SUPRACLAVICULAR: 4332444,
  BLOCK_INFRACLAVICULAR: 4332445,
  BLOCK_AXILLARY:        4336448,
  BLOCK_INTERCOSTAL:     4332575,
  // The form has one checkbox for both nerves; SNOMED has two concepts and no
  // combined one, so a single row cannot say "both". Ilioinguinal by product
  // decision, the more commonly cited target of the two, documented as a
  // decision rather than a derived fact -- the iliohypogastric half
  // (4332577) is not coded. Same shape of gap as BLOCK_SCIATIC's approach.
  BLOCK_ILIOINGUINAL: 4333290,
  BLOCK_WRIST:   4332447,
  // Scoped correctly by the tree: this node sits under Upper extremity, so the
  // hand-specific concept is right rather than one of SNOMED's five per-toe
  // foot concepts.
  BLOCK_DIGITAL: 4333956,
  // There is no concept literally named "Bier block"; IVRA is the technical
  // name and this is its exact SNOMED term.
  BLOCK_BIER:    4117443,
  // Unqualified, matching the form's node, the same reasoning as
  // BLOCK_PARAVERTEBRAL: SNOMED also has ulnar/radial/median-at-elbow
  // concepts, each more specific than the form asks for.
  BLOCK_ELBOW:   4332446,

  // PECS I has no concept literally named for it. 37017575 is not a
  // stand-in: the vocabulary's own ancestry has it as the direct parent of
  // PECS II, one level up, which mirrors the clinical relationship exactly --
  // PECS I targets the interpectoral plane, and PECS II is that block
  // extended to the serratus plane.
  BLOCK_PECS1:    37017575,
  BLOCK_PECS2:    37397715,
  BLOCK_SERRATUS: 37018762,
  // The only ESP concept in this vocabulary, and it names ultrasound
  // guidance, which the form does not record. ESP is essentially always
  // performed under ultrasound in current practice -- it is not a landmark
  // technique -- so this is very unlikely to be false, but it is still an
  // asserted detail rather than one read from the record.
  BLOCK_ESP: 37311663,
  // Unqualified, matching the form's node exactly. The vocabulary also has
  // thoracic (37116923) and lumbar (37116948) paravertebral concepts, neither
  // used here because the form does not ask which level.
  BLOCK_PARAVERTEBRAL: 4205280,
  // SNOMED splits the sciatic block by approach and has no unqualified
  // concept; the form does not record which approach was used, so this is
  // stated as one specific approach by product decision rather than derived
  // from the record. If the approach is ever added to the form, this should
  // be revisited to read from it instead of asserting lateral for every case.
  BLOCK_SCIATIC:   4215528,
  // A popliteal block is a sciatic block performed at the popliteal fossa; it
  // has no procedure concept of its own, only the same four SNOMED
  // approach-qualified sciatic concepts. Coded the same way and for the same
  // reason as BLOCK_SCIATIC, by product decision.
  BLOCK_POPLITEAL: 4215528,

  // The neuraxial family. "Neuraxial nerve block" rather than the older
  // "Central block anesthesia" (4055889), which is the same idea in the
  // phrasing the specialty has moved away from, and not the anatomically exact
  // "block around spinal cord meninges" (4122638), which would exclude a caudal
  // epidural.
  NEURAXIAL: 4228322,
  // Its own concept rather than either half. A combined spinal-epidural is not
  // a spinal with an epidural noted beside it, and the vocabulary agrees.
  CSE:       4335024,
  // An exact hit, by name, for a technique that only entered obstetric practice
  // in the last decade.
  DPE:       37159083,

  // The eye blocks are coded per leaf rather than at their parent. The obvious
  // umbrella, 4123783 (Ocular infiltration of local anesthetic), is true of
  // three of the four and flatly false of the fourth: nothing is infiltrated in
  // a topical anaesthetic. Each leaf has an exact concept, so there is nothing
  // to gain by generalising and a misstatement to lose.
  //
  // BLOCK_SUB_TENONS has no concept in any vocabulary here -- the only matches
  // for "tenon" are drug names and orbital inflammation -- so it inherits the
  // peripheral umbrella like any other unmapped node. That is a real gap in the
  // vocabulary rather than a search that gave up.
  BLOCK_PERIBULBAR:  4123785,
  BLOCK_RETROBULBAR: 4123784,
  BLOCK_TOPICAL_EYE: 4335044,
  // REGIONAL was held back until every node beneath it had been looked at, so
  // mapping it would not silently mark undecided work as done. That is now
  // true except for three confirmed gaps in the vocabulary itself, not in this
  // work: BLOCK_QL (quadratus lumborum) and BLOCK_RECTUS (rectus sheath) have
  // no procedure concept anywhere here, only anatomy and, for QL, a syndrome;
  // BLOCK_SUB_TENONS has nothing at all -- the only matches for "tenon" are
  // drug names and orbital inflammation. All three inherit REGIONAL now,
  // honestly: there is nothing more specific to find, and "Regional
  // anesthesia" is true of each of them.
  REGIONAL: 4100052,
}

/** Every technique node's parent, derived from the catalogue rather than kept
 *  in step with it by hand. */
export const TECHNIQUE_PARENT: Record<string, string> = (() => {
  const parents: Record<string, string> = {}
  const walk = (nodes: readonly TreeNode[], parent: string | null) => {
    for (const node of nodes) {
      if (parent) parents[node.v] = parent
      if (node.children) walk(node.children, node.v)
    }
  }
  walk(TECHNIQUE_TREE, null)
  return parents
})()

/** The nearest concept at or above this node, or 0 when nothing above it has
 *  one either. */
export function techniqueConceptFor(code: string): number {
  let node: string | undefined = code
  const seen = new Set<string>()
  while (node && !seen.has(node)) {
    const concept = TECHNIQUE_CONCEPTS[node]
    if (concept) return concept
    seen.add(node)
    node = TECHNIQUE_PARENT[node]
  }
  return 0
}

/**
 * Vascular access sites, coded per site.
 *
 * SNOMED has an "<artery> cannula insertion" and a "Central venous cannula
 * insertion via <vein>" family that mirrors this form's tree almost exactly,
 * so nearly every site the anaesthetist can pick has an exact concept. The two
 * parents are the backstop for the ones that do not: carotid has no arterial
 * concept at all, and the PICC subdivisions (basilic, cephalic, brachial) are
 * not separately named, so each inherits the truthful parent rather than
 * borrowing a neighbouring site's concept -- a radial line and an ulnar line
 * are different procedures and must not share an id.
 */
export const VASCULAR_ACCESS_CONCEPTS: Record<string, number> = {
  ARTERIAL:       4311043,
  ART_RADIAL:     4051187,
  ART_ULNAR:      4052409,
  ART_BRACHIAL:   4052408,
  ART_AXILLARY:   4049830,
  ART_FEMORAL:    4050420,
  // ART_CAROTID has no concept: SNOMED names temporal, subclavian, axillary,
  // brachial, radial, ulnar, femoral, tibial, dorsalis pedis, umbilical and
  // hepatic arteries, and not the carotid. It inherits ARTERIAL.

  VEN_PERIPHERAL: 4049832,
  VEN_CENTRAL:    4052413,
  CVK:            4052413,
  CVK_IJV:        4051188,
  CVK_EJV:        4052414,
  CVK_SUBCLAVIAN: 4052415,
  CVK_AXILLARY:   4050424,
  CVK_FEMORAL:    4052416,
  PICC:           4322380,
}

// Ventilation mode answers to LOINC 20124-4 (Ventilation mode Ventilator).
// PAV and Volume Guarantee (VG) had no concept in any vocabulary here -- even
// semantic search over the full concept space came back empty -- and were
// removed from the schema entirely rather than left uncoded.
export const VENTILATION_MODE_CONCEPTS: Record<string, number> = {
  "A/C":      4055375, // Assisted controlled mandatory ventilation
  "PSV":      37154096, // Pressure support ventilation
  "BiPAP":    3657511, // Recently performed administration of BiPAP ventilation
  "CPAP":     4165535, // Continuous positive airway pressure ventilation treatment
  // Approximation: SIMV alone, the vocabulary's nearest concept -- it does
  // not encode the added pressure-support component.
  "SIMV+PSV": 4245036, // Synchronized intermittent mandatory ventilation
  "VCV":      37152413, // Continuous mandatory ventilation, volume-control inflation-type
  "PCV":      37151337, // Continuous mandatory ventilation, pressure-control inflation-type
  "PRVC":     37152411, // Assist control ventilation, volume-targeted pressure-control inflation-type
  "APRV":     4072515, // Airway pressure release ventilation
  "HFOV":     4074666, // High frequency oscillatory ventilation
}

/** Every vascular-access node's parent, so an unmapped site inherits a true
 *  ancestor rather than nothing. */
const VASCULAR_ACCESS_PARENT: Record<string, string> = {
  ART_RADIAL: "ARTERIAL", ART_ULNAR: "ARTERIAL", ART_BRACHIAL: "ARTERIAL",
  ART_AXILLARY: "ARTERIAL", ART_CAROTID: "ARTERIAL", ART_FEMORAL: "ARTERIAL",
  VEN_PERIPHERAL: "VENOUS", VEN_CENTRAL: "VENOUS",
  PICC: "VEN_CENTRAL", CVK: "VEN_CENTRAL",
  PICC_BRACHIAL: "PICC", PICC_BASILIC: "PICC", PICC_CEPHALIC: "PICC",
  CVK_AXILLARY: "CVK", CVK_IJV: "CVK", CVK_EJV: "CVK",
  CVK_SUBCLAVIAN: "CVK", CVK_FEMORAL: "CVK",
}

/** The nearest vascular-access concept at or above this site, or 0. */
export function vascularAccessConceptFor(site: string | null | undefined): number {
  let node = site ?? undefined
  const seen = new Set<string>()
  while (node && !seen.has(node)) {
    const concept = VASCULAR_ACCESS_CONCEPTS[node]
    if (concept) return concept
    seen.add(node)
    node = VASCULAR_ACCESS_PARENT[node]
  }
  return 0
}

export const AIRWAY_ACT_CONCEPTS: Record<string, number> = {
  TRACHEAL_INTUBATION_ORAL:       4335481,
  // Same name, two ids -- 40431308 is the same concept, deprecated
  // (invalid_reason D); 4314149 is the live one.
  SUPRAGLOTTIC_AIRWAY_PLACEMENT:  4314149,
  // Not "Nasal intubation awake" or "Blind nasal intubation", both of which
  // assert a technique or patient state the form does not record.
  TRACHEAL_INTUBATION_NASAL:      4337616,
  DOUBLE_LUMEN_TUBE_PLACEMENT:    37116698,
  // The deliberate placement this form records, not 4134538 (Unintended
  // endobronchial intubation), which is the complication of an ordinary
  // single-lumen tube slipping too far, a different fact entirely.
  ENDOBRONCHIAL_TUBE_PLACEMENT:   4335585,
  // Cricothyroidotomy, checked: a surgical airway logged from this device
  // list is never a tracheostomy, which is a separate planned procedure done
  // by a different team, not chosen here -- and both tracheostomy concepts in
  // this vocabulary are deprecated in any case. Unqualified rather than
  // 4134560 (Emergency cricothyroidotomy): real-world use of this device is
  // almost always an emergency, but the form does not record emergency or
  // elective for it, the same reasoning as the sciatic approach and ESP's
  // ultrasound guidance -- state what is known, not what is likely.
  SURGICAL_AIRWAY: 4068680,
}

/**
 * A stored size as a number, or nothing.
 *
 * Tube sizes are stored as text because a half size is written "7.5" and some
 * older rows carry a unit or a stray space. A value that will not parse yields
 * null rather than 0: a tube of size zero does not exist, and inventing one
 * would be worse than the row being absent.
 */
// Same pattern relational-sync.ts already uses to split a free-text
// premedication entry into dose and route. There is no structured unit column
// on Medication or PremedicationAdministration -- dose is one field, "5 mg" --
// so dose_unit_source_value was carrying the whole string, including the
// number the researcher can already read out of dose_value.
const DOSE_UNIT_RE = /\d+(?:\.\d+)?\s*(mcg|mg|g|ml|mL|iu|IU|units?|tabs?|puffs?)/i
export function doseUnitOf(dose: string | null | undefined): string | null {
  return dose?.match(DOSE_UNIT_RE)?.[1] ?? null
}

// ─── Attempted, no result ────────────────────────────────────────────────────
//
// A vital the anaesthetist tried and could not obtain is not the same as one
// nobody recorded, and the difference is clinical: unobtainable readings
// cluster in shocked, arrhythmic and peripherally shut-down patients. Exporting
// both as an absent row makes the sickest cases indistinguishable from
// paperwork gaps, and any downstream imputation then fills in a plausible
// number for a patient whose finding was that no number existed.
//
// SNOMED 876785008 "Unobtainable" is a Meas Value qualifier — the same family
// as Positive/Negative/Decreased — so it belongs in measurement.value_as_concept_id
// beside a null value_as_number, which reads as "this was measured; the result
// was: unobtainable".
export const UNOBTAINABLE_CONCEPT_ID = 618772

// A handful of curated complication concepts are Observation-domain SNOMED
// findings (an airway assessment, not a diagnosed condition) rather than the
// Condition-domain disorders the rest of the catalogue resolves to. Verified
// individually while curating; kept in sync by hand with
// scripts/seed-concept-maps.ts's CURATED_COMPLICATIONS.
export const COMPLICATION_OBSERVATION_DOMAIN_CONCEPTS = new Set([
  37397718, // Difficult intubation
  37154260, // Failed intubation of trachea
  37397447, // CICO (can't intubate can't oxygenate)
  4231838,  // Accidental extubation (Inadvertent tracheal extubation)
  35625730, // Awareness under anaesthesia (Accidental awareness under general anesthesia)
  4134556,  // Delayed emergence (Delayed recovery from general anesthesia)
  4162381,  // Failed block / Regional block failure (Failed regional anesthesia)
  441207,   // Drug reaction (Adverse reaction to drug)
  4162376,  // Drug error (Medication error)
  4154707,  // Serotonin syndrome
  4010901,  // Massive haemorrhage / Unexpected major haemorrhage (Massive hemorrhage)
  443346,   // LAST (Local anesthetic drug adverse reaction)
  4266020,  // Gas supply failure (Medical gas supply failure)
  37116691, // Circuit disconnection (Breathing system disconnection)
  439625,   // Monitoring failure / Equipment malfunction (Mechanical failure of instrument or apparatus during surgical operation)
])

// Rarer still: a curated complication concept whose own domain is Procedure
// -- "Endobronchial intubation" is something that was done (a tube placed too
// far), not a diagnosed disorder or an assessment finding. Kept separate from
// the Observation set above because it routes to a third table.
export const COMPLICATION_PROCEDURE_DOMAIN_CONCEPTS = new Set([
  4335585, // Endobronchial intubation
])

// c.selections spans every LOSPOR_OPTION category (position, monitoring, ...).
// Position's curated concepts all happen to be Observation-domain, but
// monitoring's are not: a monitoring modality is frequently the SNOMED
// procedure of performing that monitoring, not a finding about the patient.
// Verified individually while curating; kept in sync by hand with
// scripts/seed-concept-maps.ts's CURATED_MONITORING.
export const SELECTION_PROCEDURE_DOMAIN_CONCEPTS = new Set([
  4187078, // ECG (Electrocardiographic monitoring)
  4019824, // TEE (Transesophageal echocardiography)
  4227418, // Nasogastric tube (Insertion of nasogastric tube)
])
export const SELECTION_MEASUREMENT_DOMAIN_CONCEPTS = new Set([
  37206739, // Cerebral oximetry / NIRS (Near-infrared spectroscopy)
])

// The airway examination has its own SNOMED concept for the same idea, and it
// is more specific than the generic qualifier: the score itself is what could
// not be assessed, not a measurement that returned nothing.
export const MALLAMPATI_NOT_ASSESSABLE_CONCEPT_ID = 4309852

// ─── LOINC / OMOP vital concept map ──────────────────────────────────────────

// unitConceptId is UCUM, verified against the same local vocabulary snapshot
// as every other concept in this file: mm[Hg] 8876, /min 8541, % 8554,
// Cel 586323, mmol/L 8753, cm 8582, kg 9529. These rows carried a written
// unit and a 0 in unit_concept_id at every site that read them -- a tool
// that trusts the coded column over the string, which is the point of
// having one, saw an unlabelled number.
export const VITAL_CONCEPTS: Record<string, { concept_id: number; code: string; system?: string; unit: string; unitConceptId: number }> = {
  systolic:    { concept_id: 3004249, code: "8480-6",  unit: "mmHg", unitConceptId: 8876 },
  diastolic:   { concept_id: 3012888, code: "8462-4",  unit: "mmHg", unitConceptId: 8876 },
  heartRate:   { concept_id: 3027018, code: "8867-4",  unit: "/min", unitConceptId: 8541 },
  spO2:        { concept_id: 3016502, code: "59408-5", unit: "%", unitConceptId: 8554 },
  etco2:       { concept_id: 3020892, code: "19889-5", unit: "mmHg", unitConceptId: 8876 },
  temp:        { concept_id: 3020891, code: "8310-5",  unit: "Cel", unitConceptId: 586323 },
  respiratoryRate: { concept_id: 3024171, code: "9279-1", unit: "/min", unitConceptId: 8541 },
  // The monitors that read a number. Timed like every other vital, because
  // when the reading was taken is part of what it means: a BIS of 22 matters
  // because of how long it stayed there, and a train-of-four of 0.4 means one
  // thing at incision and another at extubation.
  //
  // The index is dimensionless, so no unit concept is asserted rather than
  // borrowing a plausible one.
  bis:         { concept_id: 21490711, code: "75918-3", unit: "{index}", unitConceptId: 0 },
  // 250831000 is the ratio. The count is a different measurement with its own
  // concept (4353950); this row is the ratio only, so the source value names
  // SNOMED rather than claiming a LOINC code that does not exist for it.
  tofRatio:    { concept_id: 4108453,  code: "250831000", system: "SNOMED", unit: "{ratio}", unitConceptId: 8523 },
  // Always mmHg. The clinician may enter cmH2O; the conversion happens at entry
  // so the exported figure never depends on a display preference.
  cvp:         { concept_id: 21490675, code: "60985-9", unit: "mmHg", unitConceptId: 8876 },
  // Height and weight are required before a case can reach the intraoperative
  // form, so every case has them — and until they were added here the export
  // silently dropped both, while the data dictionary documented them. Weight in
  // particular is how every dose on the chart was calculated; without it a
  // reviewer cannot check a dose or study dosing at all.
  heightCm:    { concept_id: 3036277, code: "8302-2",  unit: "cm", unitConceptId: 8582 },
  weightKg:    { concept_id: 3025315, code: "29463-7", unit: "kg", unitConceptId: 9529 },
}

// Canonical lab unit string -> UCUM unit concept, covering every distinct
// unit string the 66-test lab library uses (lospor-core/src/labs.ts). Verified
// individually against the same local vocabulary snapshot as every other
// concept in this file. INR and pH carry "" -- genuinely unitless ratios and
// logarithms, the same reasoning as the 0-10 pain scales -- and are left out
// so the lookup's ?? 0 fallback is the honest answer for them, not an
// omission.
export const LAB_UNIT_CONCEPTS: Record<string, number> = {
  "g/L": 8636,
  "%": 8554,
  "×10¹²/L": 8734,
  "×10⁹/L": 9444,
  "fL": 8583,
  "pg": 8564,
  "s": 8555,
  "mg/L FEU": 44777663,
  "IU/mL": 8985,
  "mmol/L": 8753,
  "μmol/L": 8749,
  "mL/min/1.73m²": 720870,
  "U/L": 8645,
  "ng/L": 8725,
  "pg/mL": 8845,
  "μg/L": 8748,
  "mmHg": 8876,
  "mIU/L": 9040,
  "pmol/L": 8729,
  "mg/L": 8751,
  "mm/h": 8752,
}

// ─── Airway examination concepts ─────────────────────────────────────────────
//
// The airway assessment used to leave the building as LOSPOR-namespaced
// observations with concept_id 0 — present in the file, but unrecognisable to
// any tool that did not already know what LOSPOR:MALLAMPATI meant, and
// therefore not poolable with anyone else's data. Airway prediction is exactly
// what an anaesthesia register exists to study, so these carry their standard
// concepts now. The LOSPOR source values are kept alongside: they are what the
// data dictionary documents and what already-exported datasets were keyed by.
export const AIRWAY_MEASUREMENTS: Record<string, {
  concept_id: number; unit: string | null; unitConceptId: number; source: string
}> = {
  // Interincisor distance is precisely what "mouth opening in cm" measures.
  // The unit is coded as well as written: UCUM centimetre, so a tool reading
  // unit_concept_id finds one rather than the 0 these carried while the unit
  // sat in a string beside it.
  mouthOpeningCm: { concept_id: 4303387, unit: "cm", unitConceptId: 8582, source: "LOSPOR:MOUTH_OPENING_CM" },
  thyromental:    { concept_id: 4142891, unit: "cm", unitConceptId: 8582, source: "LOSPOR:THYROMENTAL_DISTANCE_CM" },
}

/**
 * Neck mobility, one concept per range the form offers.
 *
 * SNOMED also has 4124733 (Increased range of cervical spine movement), which
 * this form has no state for — noted so it is not mistaken for an omission.
 */
export const NECK_MOBILITY_CONCEPTS: Record<string, number> = {
  FULL:   4124732,
  LIMITED: 4119643,
  FIXED:  4124734,
}

/**
 * The eight ABO and Rh(D) combinations, as SNOMED states them.
 *
 * A blood group is one fact rather than two: "A positive" is what is written on
 * a crossmatch label and what a transfusion query asks for. Splitting it into a
 * group observation and a rhesus observation would make the two findable only
 * by joining them back together.
 */
export const BLOOD_GROUP_CONCEPTS: Record<string, number> = {
  "A|POSITIVE":  4082948,
  "A|NEGATIVE":  4080397,
  "B|POSITIVE":  4175555,
  "B|NEGATIVE":  4080398,
  "AB|POSITIVE": 4080396,
  "AB|NEGATIVE": 4082949,
  "O|POSITIVE":  4080395,
  "O|NEGATIVE":  4082947,
}

export function bloodGroupConceptFor(
  group: string | null | undefined,
  rhesus: string | null | undefined,
): number {
  if (!group || !rhesus) return 0
  return BLOOD_GROUP_CONCEPTS[`${group}|${rhesus}`] ?? 0
}

/**
 * A clinical yes and no, as SNOMED Qualifier Values.
 *
 * The same concept class the procedure urgency modifier uses. These say only
 * what was answered and add nothing to the question, which is the point: a
 * question-specific value concept — "Never smoked" for a false smoking flag —
 * states more than the form asked.
 */
export const YES_CONCEPT_ID = 4188539
export const NO_CONCEPT_ID = 4188540

/**
 * ASA physical status, one standard concept per class.
 *
 * SNOMED also carries an older "ASA grade I/II/III" set — 4199572, 4201721,
 * 4200663 and the rest — which reads as the obvious match and is invalid
 * (`invalid_reason` U). These are the current ones.
 */
export const ASA_CLASS_CONCEPTS: Record<string, number> = {
  // Keyed on the Roman numerals the form stores and the schema enumerates.
  // Arabic keys would have looked entirely correct and resolved every class to
  // concept 0.
  I: 4186042,
  II: 4184967,
  III: 4186043,
  IV: 4211334,
  V: 4186044,
  VI: 4186045,
}

/** Mallampati and Cormack-Lehane are graded scales, not quantities. */
export const AIRWAY_GRADES: Record<string, {
  concept_id: number
  source: string
  grades: Record<string, number>
}> = {
  mallampati: {
    concept_id: 4165278,
    source: "LOSPOR:MALLAMPATI",
    grades: { I: 4322393, II: 4313490, III: 4312672, IV: 4314609 },
  },
  cormackLehane: {
    concept_id: 37398987,
    source: "LOSPOR:CORMACK_LEHANE",
    // IIa and IIb are the Cook subdivision; SNOMED grades to II for both, and
    // the exact subgrade stays in the LOSPOR source value.
    grades: { I: 4219400, II: 4221760, IIa: 4221760, IIb: 4221760, III: 4212073, IV: 4166735 },
  },
}
