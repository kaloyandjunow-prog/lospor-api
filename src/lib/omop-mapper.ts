/**
 * OMOP CDM v5.4 mapper — export contract `source_version` 3.8.0.
 *
 * `source_version` tracks the shape of the export, not the app version: bump it
 * whenever a table or column is added, removed or reinterpreted.
 *
 * 3.8.0 — the shape changes since 3.7.0, none of which had been released.
 *
 *         CARE_SITE is emitted as its own table and referenced by
 *         care_site_id, instead of the site being written onto
 *         VISIT_OCCURRENCE as a bare string.
 *
 *         Allergies stop being exported as DRUG_EXPOSURE. Medication.kind is
 *         CURRENT | ALLERGY, and the export iterated both, so a substance the
 *         patient reacts to was recorded as one they were given. Allergies now
 *         become observations, which is a different claim in the right place.
 *
 *         Continuous administrations gain drug_exposure_end_date, paired from
 *         their stop events. Every planned procedure is exported, not the
 *         first. Intraoperative drugs resolve their ATC through the same
 *         concept pipeline as relational medications.
 *
 *         Clinical yes/no questions emit for a recorded "no" as well as a
 *         "yes". They were nullable-free booleans, so silence was the only
 *         honest option; the columns are now nullable and silence means the
 *         question was never asked.
 *
 *         Airway management is exported: device list, Cormack-Lehane grade,
 *         tools, per-device sizes and cuff status, DLT type/side/size,
 *         endobronchial size, ventilation modes, IPPV, jet ventilation and
 *         PEEP. Placing an instrumented airway is also emitted as a
 *         PROCEDURE_OCCURRENCE, separating what was done to the patient from
 *         what was true of them.
 *
 *         Preop findings that were read out of the database and written to no
 *         table now leave: smoking, substance use, latex allergy, family
 *         anaesthesia history, dental state, cardiac arrhythmia, BMI, blood
 *         group and Rh, GUTA, the airway examination (mouth opening,
 *         thyromental distance, neck mobility, upper lip bite test,
 *         retrognathia, prominent incisors, facial hair), and the free-text
 *         allergy, family-history and difficult-airway notes, redacted.
 *
 *         MEASUREMENT gains value_source_value, range_low and range_high.
 *         A lab result with no parsed number used to be skipped entirely, so a
 *         culture, a dipstick or a blood group left no trace of having been
 *         recorded; it is now exported with the value the lab reported. The
 *         reference range travels with the result, because ranges differ by
 *         laboratory, assay and patient age, and "high" is not a claim the
 *         export can support without the range that produced it. The abnormal
 *         flag rides as its own observation, keyed to the measurement's source
 *         value, since CDM 5.4 has no column for it.
 *
 *         Vascular lines carry their depth, lumen count and whether they were
 *         already in place. A pre-existing line was not placed during this
 *         case, so its procedure row overstates the work without that flag.
 *
 *         mapping_summary gains manually_curated_rows and rejected_rows.
 *         MAPPED covered both an automatic resolution and one a human signed
 *         off, and UNMAPPED covered both "nobody has looked" and "a candidate
 *         was rejected" -- so the summary could not distinguish evidence from
 *         guesswork, or finished review work from a backlog.
 * 3.7.0 — OBSERVATION gains value_as_number, the CDM column a numeric
 *         observation belongs in. Every score the export carries (RCRI, Apfel,
 *         STOP-BANG, the Aldrete subscores and total, POVOC, COLDS, PAED, the
 *         paediatric pain scales, fluid totals, durations) was written only as
 *         text, so a researcher could not sum, average or threshold one without
 *         casting it back. The string form is kept alongside for values that
 *         are genuinely textual and for consumers already reading it.
 * 3.6.0 — preserves pediatric mode, precise age, rule provenance, pediatric
 *         risk scores, and pediatric recovery scores as source observations.
 *         No unreviewed standard concept IDs are assigned.
 * 3.5.1 — production export includes real intraoperative start/end instants in
 *         the selected row shape, so visit dates use startedAt/endedAt when
 *         present instead of falling back to legacy wall-clock columns.
 * 3.5.0 — emits PERSON and OBSERVATION_PERIOD, the root tables the CDM and the
 *         OHDSI tools (ATLAS, ACHILLES) require; without them earlier bundles
 *         were OMOP-shaped but could not be loaded. person_id is now derived
 *         from SHA-256 (52 bits) instead of a 32-bit string hash that would
 *         have collided two unrelated cases onto one person around ~70k cases.
 * 3.4.x — drug exposure from CaseEvent rows; LOINC-coded lab measurements from
 *         LabResult; care_site_source_value from Case.institutionId.
 *
 * Concept IDs stay 0 where LOSPOR has no confident standard-vocabulary mapping
 * (vitals, which carry real LOINC-backed concept_ids, are the exception). No
 * identifier is ever invented — source vocabulary and code are carried instead.
 */

import { createHash } from "node:crypto"
import { DICTIONARY_VERSION } from "@/lib/data-dictionary"
import { formatCanonicalConcentration } from "@/lib/case-event-schema"
import { deriveQualityStatus } from "@lospor/core/omop"
import { TECHNIQUE_TREE } from "@lospor/core/catalog"
import type { TreeNode } from "@lospor/core/catalog"

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 1
function nextId() { return _counter++ }
function resetIds(start = 1) { _counter = start }

// Optional deployment-wide salt. Keep it stable: changing it changes every
// pseudonym, so two exports taken either side of a change cannot be related.
const PSEUDONYM_SALT = process.env.OMOP_PSEUDONYM_SALT ?? ""

/**
 * Deterministic pseudonymous ID, derived from SHA-256.
 *
 * Takes 52 bits of the digest — the widest value that stays an exact JavaScript
 * integer. Collision becomes likely (birthday bound) somewhere past 60 million
 * cases rather than the ~70 thousand of the previous 32-bit string hash, which
 * would have silently merged two unrelated operations into one "person".
 *
 * `kind` namespaces the id so a case's person and visit ids can never coincide.
 */
function pseudonymId(kind: string, key: string): number {
  const digest = createHash("sha256").update(`${PSEUDONYM_SALT}|${kind}|${key}`).digest()
  const hi = digest.readUInt32BE(0)         // 32 bits
  const lo = digest.readUInt32BE(4) >>> 12  // top 20 bits of the next word
  return hi * 0x100000 + lo + 1             // 52 bits, never zero
}

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
const TECHNIQUE_CONCEPTS: Record<string, number> = {
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
const TECHNIQUE_PARENT: Record<string, string> = (() => {
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
 * The airway act each device implies, coded.
 *
 * Only the oral tube is decided so far. The rest stay at 0 deliberately rather
 * than being filled with the nearest-looking concept: a supraglottic airway and
 * a double-lumen tube are different procedures with different concepts, and
 * guessing them would be indistinguishable, in the export, from having chosen
 * them.
 */
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
const VASCULAR_ACCESS_CONCEPTS: Record<string, number> = {
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

const AIRWAY_ACT_CONCEPTS: Record<string, number> = {
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
function doseUnitOf(dose: string | null | undefined): string | null {
  return dose?.match(DOSE_UNIT_RE)?.[1] ?? null
}

function numOrNull(value: unknown): number | null {
  if (value == null || value === "") return null
  const n = typeof value === "number" ? value : parseFloat(String(value))
  return Number.isFinite(n) ? n : null
}

function isoDate(d: Date | string | null | undefined): string | null {
  if (!d) return null
  const dt = typeof d === "string" ? new Date(d) : d
  return isNaN(dt.getTime()) ? null : dt.toISOString().substring(0, 10)
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
const UNOBTAINABLE_CONCEPT_ID = 618772

// A handful of curated complication concepts are Observation-domain SNOMED
// findings (an airway assessment, not a diagnosed condition) rather than the
// Condition-domain disorders the rest of the catalogue resolves to. Verified
// individually while curating; kept in sync by hand with
// scripts/seed-concept-maps.ts's CURATED_COMPLICATIONS.
const COMPLICATION_OBSERVATION_DOMAIN_CONCEPTS = new Set([
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
const COMPLICATION_PROCEDURE_DOMAIN_CONCEPTS = new Set([
  4335585, // Endobronchial intubation
])

// The airway examination has its own SNOMED concept for the same idea, and it
// is more specific than the generic qualifier: the score itself is what could
// not be assessed, not a measurement that returned nothing.
const MALLAMPATI_NOT_ASSESSABLE_CONCEPT_ID = 4309852

// ─── LOINC / OMOP vital concept map ──────────────────────────────────────────

// unitConceptId is UCUM, verified against the same local vocabulary snapshot
// as every other concept in this file: mm[Hg] 8876, /min 8541, % 8554,
// Cel 586323, mmol/L 8753, cm 8582, kg 9529. These rows carried a written
// unit and a 0 in unit_concept_id at every site that read them -- a tool
// that trusts the coded column over the string, which is the point of
// having one, saw an unlabelled number.
const VITAL_CONCEPTS: Record<string, { concept_id: number; loinc: string; unit: string; unitConceptId: number }> = {
  systolic:    { concept_id: 3004249, loinc: "8480-6",  unit: "mmHg", unitConceptId: 8876 },
  diastolic:   { concept_id: 3012888, loinc: "8462-4",  unit: "mmHg", unitConceptId: 8876 },
  heartRate:   { concept_id: 3027018, loinc: "8867-4",  unit: "/min", unitConceptId: 8541 },
  spO2:        { concept_id: 3016502, loinc: "59408-5", unit: "%", unitConceptId: 8554 },
  etco2:       { concept_id: 3020892, loinc: "19889-5", unit: "mmHg", unitConceptId: 8876 },
  temp:        { concept_id: 3020891, loinc: "8310-5",  unit: "Cel", unitConceptId: 586323 },
  // 3004501, not 0. This row carried the right LOINC code and then threw the
  // concept away, so every intraoperative glucose exported unmapped while
  // sitting next to a code that identifies it exactly.
  bgl:         { concept_id: 3004501, loinc: "2345-7",  unit: "mmol/L", unitConceptId: 8753 },
  respiratoryRate: { concept_id: 3024171, loinc: "9279-1", unit: "/min", unitConceptId: 8541 },
  // Height and weight are required before a case can reach the intraoperative
  // form, so every case has them — and until they were added here the export
  // silently dropped both, while the data dictionary documented them. Weight in
  // particular is how every dose on the chart was calculated; without it a
  // reviewer cannot check a dose or study dosing at all.
  heightCm:    { concept_id: 3036277, loinc: "8302-2",  unit: "cm", unitConceptId: 8582 },
  weightKg:    { concept_id: 3025315, loinc: "29463-7", unit: "kg", unitConceptId: 9529 },
}

// Canonical lab unit string -> UCUM unit concept, covering every distinct
// unit string the 66-test lab library uses (lospor-core/src/labs.ts). Verified
// individually against the same local vocabulary snapshot as every other
// concept in this file. INR and pH carry "" -- genuinely unitless ratios and
// logarithms, the same reasoning as the 0-10 pain scales -- and are left out
// so the lookup's ?? 0 fallback is the honest answer for them, not an
// omission.
const LAB_UNIT_CONCEPTS: Record<string, number> = {
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
const AIRWAY_MEASUREMENTS: Record<string, {
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
const NECK_MOBILITY_CONCEPTS: Record<string, number> = {
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
const BLOOD_GROUP_CONCEPTS: Record<string, number> = {
  "A|POSITIVE":  4082948,
  "A|NEGATIVE":  4080397,
  "B|POSITIVE":  4175555,
  "B|NEGATIVE":  4080398,
  "AB|POSITIVE": 4080396,
  "AB|NEGATIVE": 4082949,
  "O|POSITIVE":  4080395,
  "O|NEGATIVE":  4082947,
}

function bloodGroupConceptFor(
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
const YES_CONCEPT_ID = 4188539
const NO_CONCEPT_ID = 4188540

/**
 * ASA physical status, one standard concept per class.
 *
 * SNOMED also carries an older "ASA grade I/II/III" set — 4199572, 4201721,
 * 4200663 and the rest — which reads as the obvious match and is invalid
 * (`invalid_reason` U). These are the current ones.
 */
const ASA_CLASS_CONCEPTS: Record<string, number> = {
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
const AIRWAY_GRADES: Record<string, {
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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OmopBundle {
  metadata: {
    export_id: string
    omop_cdm_version: string
    generated_at: string
    generated_by_user_id: string
    generated_by_role: string
    source: string
    source_version: string
    schema_version: string
    concept_map_version: string
    data_dictionary_version: string
    case_status_filter: string[]
    date_range: { from: string; to: string } | null
    matching_case_count: number
    exported_case_count: number
    complete: boolean
    included_case_count: number
    excluded_case_count: number
    app_git_commit: string
    forced_override: boolean
    case_count: number
    mapping_summary: {
      mapped_rows: number
      /** Of mapped_rows, how many a human reviewed and signed off. */
      manually_curated_rows: number
      /** Candidates considered and rejected. Not part of the unmapped backlog. */
      rejected_rows: number
      source_only_rows: number
      unmapped_rows: number
    }
    table_counts: Record<string, number>
    quality_warnings: ExportQualityWarning[]
    data_quality_status: "PASS" | "WARNING" | "FAIL"
    deidentification: {
      mode: string
      person_id_strategy: string
      direct_patient_identifiers_stored: boolean
      event_timestamp_precision: string
      residual_linkage_risks: string[]
    }
    note: string
  }
  // PERSON is the root of the OMOP model — every clinical row references it,
  // and OBSERVATION_PERIOD is what OHDSI tooling (ATLAS, ACHILLES) uses to
  // decide when a person was under observation. Without both, the bundle is
  // OMOP-shaped but not loadable.
  // A dimension rather than a clinical event: one row per place, referenced by
  // VISIT_OCCURRENCE. The institution used to be written onto every visit as
  // free text, in a column no OHDSI tool reads.
  care_site: OmopCareSite[]
  person: OmopPerson[]
  observation_period: OmopObservationPeriod[]
  visit_occurrence: OmopVisit[]
  condition_occurrence: OmopCondition[]
  drug_exposure: OmopDrug[]
  measurement: OmopMeasurement[]
  procedure_occurrence: OmopProcedure[]
  device_exposure: OmopDevice[]
  observation: OmopObservation[]
}

/**
 * A device placed in the patient.
 *
 * The airway devices had exact Device-domain concepts and nowhere to put them:
 * this export produced nine tables and none of them was the one the CDM
 * reserves for exactly this. Emitting an endotracheal tube as an observation
 * would have put a Device-domain concept in an Observation column, which is
 * the violation the OHDSI data-quality checks exist to catch, so they stayed
 * at concept 0 instead -- correct, and useless to anyone searching for them.
 *
 * Separate from the airway *act* in PROCEDURE_OCCURRENCE, which is deliberate
 * and not duplication: placing a tube is something done to the patient, and
 * the tube itself is a thing that was in them. A cohort of "patients
 * intubated" wants the procedure; a cohort of "cases where a videolaryngoscope
 * was used" wants the device.
 */
export interface OmopDevice {
  device_exposure_id: number
  person_id: number
  device_concept_id: number
  device_exposure_start_date: string | null
  device_exposure_end_date: string | null
  device_type_concept_id: number
  device_source_value: string | null
  visit_occurrence_id: number
}

export interface OmopCareSite {
  care_site_id: number
  care_site_name: string | null
  place_of_service_concept_id: number
  care_site_source_value: string | null
}

export interface OmopPerson {
  person_id: number
  gender_concept_id: number
  year_of_birth: number | null
  month_of_birth: null
  day_of_birth: null
  birth_datetime: null
  race_concept_id: number
  ethnicity_concept_id: number
  person_source_value: string | null
  gender_source_value: string | null
}

export interface OmopObservationPeriod {
  observation_period_id: number
  person_id: number
  observation_period_start_date: string | null
  observation_period_end_date: string | null
  period_type_concept_id: number
}

export type ExportQualityWarning = {
  code: string
  severity: "info" | "warning" | "error"
  message: string
  count?: number
}

interface OmopVisit {
  visit_occurrence_id: number
  person_id: number
  visit_concept_id: number
  visit_start_date: string | null
  visit_start_datetime: string | null
  visit_end_date: string | null
  visit_end_datetime: string | null
  visit_type_concept_id: number
  visit_source_value: string | null
  care_site_id: number | null
  care_site_source_value: string | null
}

interface OmopCondition {
  condition_occurrence_id: number
  person_id: number
  condition_concept_id: number
  condition_start_date: string | null
  condition_type_concept_id: number
  condition_source_value: string | null
  visit_occurrence_id: number
}

interface OmopDrug {
  drug_exposure_id: number
  person_id: number
  drug_concept_id: number
  drug_exposure_start_date: string | null
  // Null means genuinely open — an administration still running when the case
  // ended — not "unknown". A single-shot drug has no interval and is null too.
  drug_exposure_end_date: string | null
  drug_type_concept_id: number
  drug_source_value: string | null
  // A concept id, per the CDM: an integer or nothing. Source vocabulary text
  // belongs in drug_source_value. This column held strings like "ATC:N01AH01",
  // which a loader must either reject or silently coerce away.
  drug_source_concept_id: number | null
  dose_value: number | null
  dose_unit_source_value: string | null
  route_source_value: string | null
  visit_occurrence_id: number
}

interface OmopMeasurement {
  measurement_id: number
  person_id: number
  measurement_concept_id: number
  measurement_date: string | null
  measurement_datetime: string | null
  measurement_type_concept_id: number
  value_as_number: number | null
  /**
   * The coded answer, for results that are not a quantity: a graded scale, or
   * a measurement that was attempted and could not be obtained. Null whenever
   * value_as_number carries the result instead.
   */
  value_as_concept_id: number | null
  unit_concept_id: number
  unit_source_value: string | null
  measurement_source_value: string | null
  /** The value as the source reported it, including qualitative results. */
  value_source_value: string | null
  /** The reference range this result was judged against, where the lab gave one. */
  range_low: number | null
  range_high: number | null
  visit_occurrence_id: number
}

interface OmopProcedure {
  procedure_occurrence_id: number
  person_id: number
  procedure_concept_id: number
  procedure_date: string | null
  // Optional: most procedures here are known only to the day (the case's own
  // start date). A few are also witnessed as a precise intraop timeline
  // event -- when one exists, it refines this row's time rather than adding
  // a second, duplicate row for the same procedure.
  procedure_datetime?: string | null
  procedure_type_concept_id: number
  /**
   * A qualifier on the operation, not a second operation.
   *
   * Urgency is the case this exists for. "Emergency procedure" (4158569) is the
   * closest concept to what the form asks, but emitted as its own
   * procedure_occurrence row it would make one appendectomy count as two
   * procedures and put an extra hit into any cohort defined over a procedure
   * concept set. The CDM's answer is this column: the operation stays one row,
   * and how it was performed hangs off it.
   */
  modifier_concept_id: number
  modifier_source_value: string | null
  procedure_source_value: string | null
  visit_occurrence_id: number
}

interface OmopObservation {
  observation_id: number
  person_id: number
  observation_concept_id: number
  observation_date: string | null
  observation_type_concept_id: number
  // OMOP puts a numeric observation in value_as_number and a textual one in
  // value_as_string. Everything used to go through value_as_string, which made
  // every score in the export a string: a researcher could not average an
  // Aldrete total or threshold an RCRI without casting it back, and the
  // dictionary documented 26 of them as living in a column the row did not
  // have. Numbers are now written to both — the number so it can be used as
  // one, the string so nothing already reading value_as_string breaks.
  value_as_number: number | null
  value_as_string: string | null
  /**
   * The answer as a concept, where the answer is one the vocabulary can state.
   *
   * A clinical yes/no lives here as SNOMED Yes (4188539) or No (4188540), which
   * no tool can read out of the string "true". The alternative was a value
   * concept per question — "Never smoked" for a false smoking flag — and that
   * asserts more than the form asked: a boolean that means "not currently
   * smoking" covers the never-smoker and the ex-smoker alike, and calling both
   * "never" is wrong for one of them.
   *
   * 0 where there is no coded answer, which is every free-text and numeric
   * observation.
   */
  value_as_concept_id: number
  observation_source_value: string | null
  visit_occurrence_id: number
}

// ─── Main mapper ──────────────────────────────────────────────────────────────

type CaseRow = {
  id: string
  /** Dedicated opaque research identifier; never substitute caseCode here. */
  researchId: string
  createdAt: Date
  status: string
  clinicalMode?: "ADULT" | "PEDIATRIC"
  clinicalRulesVersion?: string | null
  institutionId?: string | null
  user?: { institution?: { name: string | null } | null } | null
  events?: {
    type: string
    timestamp: Date
    label: string | null
    value: string | null
    unit: string | null
    rate?: string | null
    concentration?: string | null
    concentrationValue?: number | null
    concentrationUnit?: string | null
    formulation?: string | null
    calculationBasis?: string | null
    calculationWeightKg?: number | null
    calculationMethod?: string | null
    clinicalRuleKey?: string | null
    clinicalRuleVersion?: string | null
    clinicalRuleSourceIds?: unknown
    clinicalPresetId?: string | null
    clinicalPresetVersion?: number | null
    clinicalPresetScope?: string | null
    volume?: string | null
    fluidCategory?: string | null
    agentPercent?: number | null
    fgfLitersPerMin?: number | null
    carrierGas?: string | null
    fio2Percent?: number | null
    fiAirPercent?: number | null
    fiN2OPercent?: number | null
    systolic?: number | null
    diastolic?: number | null
    heartRate?: number | null
    spO2?: number | null
    etco2?: number | null
    temp?: number | null
    bgl: number | null
    bglLoincCode: string | null
    bglUnitCanon: string | null
    atcCode: string | null
    drugId: string | null
    standardConceptId?: number | null
    mappingStatus?: string
    // Pairing keys: an infusion's start and stop share infId, a fluid's share
    // fluidId. Volatile agents have no key — only one runs at a time, so a stop
    // closes whichever is open, which is how the intraop engine reads them too.
    infId?: string | null
    fluidId?: string | null
    inn?: string | null
    drugRoute?: string | null
    metadataJson: unknown
  }[]
  selections?: {
    section: string
    category: string
    value: string
    ordinal: number
    sourceVocabulary?: string | null
    sourceCode?: string | null
    standardConceptId?: number | null
    mappingStatus?: string
  }[]
  complications?: {
    section: string
    label: string
    note: string | null
    timestamp: Date | null
    source: string | null
    ordinal: number
    sourceVocabulary?: string | null
    sourceCode?: string | null
    standardConceptId?: number | null
    mappingStatus?: string
  }[]
  preop?: {
    ageYears: number | null
    ageValue?: number | null
    ageUnit?: "DAYS" | "MONTHS" | "YEARS" | null
    ageApproxDays?: number | null
    bodySurfaceAreaM2?: number | null
    pediatricFasting?: unknown
    sex: string
    heightCm: number | null
    weightKg: number | null
    bpSystolic: number | null
    bpDiastolic: number | null
    heartRate: number | null
    spO2: number | null
    temperature: number | null
    respiratoryRate: number | null
    diagnosis: string
    diagnosesJson: unknown
    plannedProcedure: string
    proceduresJson: unknown
    comorbidities: unknown
    asaScore: string | null
    emergencySurgery: boolean
    highRiskSurgery: boolean
    allergies: boolean | null
    allergyDetails: string | null
    smoking: boolean | null
    substanceAbuse: boolean | null
    currentMedications: string | null
    rcriScore: number | null
    apfelScore: number | null
    stopBangScore: number | null
    povocScore?: number | null
    povocRiskPercent?: number | null
    coldsScore?: number | null
    difficultAirwayHistory: boolean | null
    mallampati: string | null
    // Attempted-but-not-obtained. One flag can qualify several readings: the
    // blood-pressure flag covers systolic and diastolic, the airway flag covers
    // the whole examination.
    bpUnobtainable?: boolean | null
    heartRateUnobtainable?: boolean | null
    spO2Unobtainable?: boolean | null
    temperatureUnobtainable?: boolean | null
    respiratoryRateUnobtainable?: boolean | null
    airwayUnobtainable?: boolean | null
    // Clinical detail the export used to read and discard.
    bmi?: number | null
    bloodType?: string | null
    rhFactor?: string | null
    gutaScore?: number | null
    latexAllergy?: boolean | null
    familyAnesthesiaProblems?: boolean | null
    familyAnesthesiaDetails?: string | null
    dentalProsthetics?: boolean | null
    looseTeeth?: boolean | null
    heartArrhythmia?: boolean | null
    mouthOpeningCm?: number | null
    thyromental?: number | null
    neckMobility?: string | null
    upperLipBiteTest?: string | null
    retrognathia?: boolean | null
    prominentIncisors?: boolean | null
    facialHair?: boolean | null
    difficultAirwayNotes?: string | null
    anticipatedDifficultAirway?: boolean | null
    malignantHyperthermiaHistory?: boolean | null
    unexplainedAnaesthesiaComplications?: boolean | null
    labResults: unknown
    labRows?: {
      test: string
      valueNum: number | null
      value: string | null
      unitCanon: string | null
      loincCode: string | null
      abnormalFlag: string | null
      referenceLow?: number | null
      referenceHigh?: number | null
      standardConceptId?: number | null
      mappingStatus?: string
    }[]
    diagnoses?: {
      code: string | null
      label: string
      labelEn: string | null
      labelBg: string | null
      sourceVocabulary?: string | null
      sourceCode?: string | null
      standardConceptId?: number | null
      mappingStatus?: string
      ordinal: number
    }[]
    procedureRows?: {
      code: string | null
      group: string | null
      domain: string | null
      description: string | null
      sourceVocabulary?: string | null
      sourceCode?: string | null
      standardConceptId?: number | null
      mappingStatus?: string
      ordinal: number
    }[]
    comorbidityRows?: {
      label: string
      labelEn: string | null
      labelBg: string | null
      code: string | null
      icd10Code: string | null
      sourceVocabulary?: string | null
      sourceCode?: string | null
      standardConceptId?: number | null
      mappingStatus?: string
      ordinal: number
    }[]
    medications?: {
      kind: string
      nameRaw: string
      inn: string | null
      atcCode: string | null
      dose: string | null
      route: string | null
      sourceVocabulary?: string | null
      sourceCode?: string | null
      standardConceptId?: number | null
      mappingStatus?: string
      ordinal: number
    }[]
  } | null
  intraop?: {
    // Real instants when the record has them — the only form that can be placed
    // on a timeline or compared across sites.
    startedAt?: Date | null
    endedAt?: Date | null
    timezone?: string | null
    // Legacy bare wall clock, nullable: a case may not have started, and older
    // rows carry no zone so this cannot be resolved to a true instant.
    startTime: Date | null
    endTime: Date | null
    durationMinutes: number | null
    monthYear: string | null
    techniques: unknown
    keyEvents: unknown
    crystalloidsMl: number | null
    colloidsMl: number | null
    bloodMl: number | null
    urineMl: number | null
    bloodLossMl: number | null
    complications: string | null
    premedicationEvening: string | null
    premedicationMorning: string | null
    airwayDevice: string | null
    // Airway management detail. `airwayDevices` is the current multi-device
    // list; `airwayDevice` is the older single value and both may be set.
    airwayDevices?: unknown
    cormackLehane?: string | null
    airwayTools?: unknown
    fob?: boolean | null
    lmaSize?: number | null
    oralTubeSize?: number | null
    oralCuffed?: boolean | null
    nasalTubeSize?: number | null
    nasalCuffed?: boolean | null
    dltType?: string | null
    dltSide?: string | null
    dltSize?: number | null
    endobronchialSize?: number | null
    // Legacy shared size/cuff, written before the per-device columns existed.
    tubeSize?: number | null
    cuffed?: boolean | null
    ventilationModes?: unknown
    ippv?: boolean | null
    jetVentilation?: boolean | null
    peepCmH2O?: number | null
    vascularAccessRows?: {
      site: string | null
      siteLabel: string | null
      size: string | null
      sizeUnit: string | null
      depthCm: string | null
      lumens: string | null
      preexisting: boolean
      ordinal: number
      sourceVocabulary?: string | null
      sourceCode?: string | null
      standardConceptId?: number | null
      mappingStatus?: string
    }[]
    premedicationRows?: {
      phase: string
      nameRaw: string
      inn: string | null
      atcCode: string | null
      standardConceptId?: number | null
      mappingStatus?: string
      dose: string | null
      route: string | null
      ordinal: number
    }[]
  } | null
  postop?: {
    aldreteActivity: number | null
    aldreteRespiration: number | null
    aldreteCirculation: number | null
    aldreteConsciousness: number | null
    aldreteSpO2: number | null
    aldreteTotal: number | null
    recoveryBpUnobtainable?: boolean | null
    recoveryHeartRateUnobtainable?: boolean | null
    recoverySpO2Unobtainable?: boolean | null
    recoveryTemperatureUnobtainable?: boolean | null
    recoveryBpSystolic: number | null
    recoveryBpDiastolic: number | null
    recoveryHeartRate: number | null
    recoverySpO2: number | null
    temperatureCelsius: number | null
    painScoreNRS: number | null
    pediatricPainScale?: "FLACC" | "FPS_R" | "NRS" | null
    pediatricPainScore?: number | null
    paedScore?: number | null
    ponv: boolean | null
    disposition: string | null
    complications: string | null
  } | null
  fieldStatuses?: {
    section: string
    fieldKey: string
    presence: string
  }[]
  // A case now holds one finalization per attestation, so presence is a count
  // rather than a single row. Declared required, unlike the optional `snapshot`
  // it replaces: that optionality is what let a rename pass the type checker
  // while quietly reporting every finalised case as missing its snapshot.
  finalizations: { id: string }[]
  updatedAt?: Date
  finalizedAt?: Date | null
}

function buildQualityWarnings(
  cases: CaseRow[],
  mappingSummary: { mapped_rows: number; manually_curated_rows: number; rejected_rows: number; source_only_rows: number; unmapped_rows: number },
): ExportQualityWarning[] {
  const warnings: ExportQualityWarning[] = []

  // ── Error-level (FAIL) checks ──────────────────────────────────────────────

  const nonFinalizedCount = cases.filter(c => c.status !== "COMPLETE").length
  if (nonFinalizedCount > 0) {
    warnings.push({
      code: "NON_FINALIZED_CASES",
      severity: "error",
      message: "Export includes cases that have not been finalised (status !== COMPLETE). Research integrity requires finalised cases only.",
      count: nonFinalizedCount,
    })
  }

  const missingSnapshotCount = cases.filter(c =>
    c.status === "COMPLETE" && c.finalizations.length === 0).length
  if (missingSnapshotCount > 0) {
    warnings.push({
      code: "MISSING_FINALIZATION_SNAPSHOT",
      severity: "error",
      message: "Some finalised cases have no immutable snapshot. The snapshot is written at finalisation; its absence indicates a corrupted or interrupted finalisation.",
      count: missingSnapshotCount,
    })
  }

  const relationalDriftCount = cases.filter(c => {
    if (!c.updatedAt || !c.finalizedAt) return false
    return c.updatedAt.getTime() > c.finalizedAt.getTime() + 5_000
  }).length
  if (relationalDriftCount > 0) {
    warnings.push({
      code: "RELATIONAL_DRIFT",
      severity: "error",
      message: "Some cases were edited after finalisation (updatedAt > finalizedAt). The snapshot may not match the exported data.",
      count: relationalDriftCount,
    })
  }

  const impossibleTimestampCount = cases.filter(c => {
    const start = c.intraop?.startedAt ?? c.intraop?.startTime
    const end = c.intraop?.endedAt ?? c.intraop?.endTime
    if (!start || !end) return false
    return end < start
  }).length
  if (impossibleTimestampCount > 0) {
    warnings.push({
      code: "IMPOSSIBLE_TIMESTAMPS",
      severity: "error",
      message: "Some cases have intraoperative end time before start time, indicating a data entry error.",
      count: impossibleTimestampCount,
    })
  }

  // ── Warning-level checks ───────────────────────────────────────────────────

  const casesWithoutFieldStatus = cases.filter(c => (c.fieldStatuses ?? []).length === 0).length
  const exactTimestampRows = cases.reduce((sum, c) => sum + (c.events ?? []).length, 0)
  const freeTextComplications = cases.reduce((sum, c) => sum + (c.complications ?? []).filter(comp => Boolean(comp.note)).length, 0)
  // Counted from the case alone, matching what the export actually writes as
  // the care site. Counting the author's institution here would report cases as
  // institution-linked whose exported care site is null.
  const institutionLinked = cases.filter(c => Boolean(c.institutionId)).length

  if (mappingSummary.unmapped_rows > 0) {
    warnings.push({
      code: "UNMAPPED_CONCEPT_ROWS",
      severity: "warning",
      message: "Some normalized rows have no source or standard vocabulary mapping.",
      count: mappingSummary.unmapped_rows,
    })
  }
  if (mappingSummary.source_only_rows > 0) {
    warnings.push({
      code: "SOURCE_ONLY_CONCEPT_ROWS",
      severity: "info",
      message: "Some rows preserve source vocabulary/code without a confident OMOP standard concept ID.",
      count: mappingSummary.source_only_rows,
    })
  }
  if (casesWithoutFieldStatus > 0) {
    warnings.push({
      code: "NO_FIELD_STATUS_ROWS",
      severity: "error",
      message: "Some cases have no ClinicalFieldStatus rows. Field-level missingness cannot be determined; relational sync may not have run.",
      count: casesWithoutFieldStatus,
    })
  }
  if (exactTimestampRows > 0) {
    warnings.push({
      code: "EXACT_EVENT_TIMESTAMPS",
      severity: "info",
      message: "Intraoperative events retain exact timestamps for clinical sequence analysis; this is a residual linkage risk.",
      count: exactTimestampRows,
    })
  }
  if (institutionLinked > 0) {
    warnings.push({
      code: "INSTITUTION_LINKAGE",
      severity: "info",
      message: "Exports include care_site_source_value for research governance; small institutions can increase re-identification risk.",
      count: institutionLinked,
    })
  }
  if (freeTextComplications > 0) {
    warnings.push({
      code: "REDACTED_FREE_TEXT_PRESENT",
      severity: "warning",
      message: "Free-text complication notes existed and were passed through the export redaction pipeline. Review redacted output before sharing.",
      count: freeTextComplications,
    })
  }
  return warnings
}

export interface ExportContext {
  userId: string
  userRole: string
  statusFilter: string[]
  excludedCaseCount: number
  matchingCaseCount?: number
  complete?: boolean
  gitCommit: string
  forcedOverride: boolean
  exportId?: string
  generatedAt?: string
  rowIdStart?: number
}

export function mapCasesToOmop(cases: CaseRow[], ctx?: ExportContext): OmopBundle {
  resetIds(ctx?.rowIdStart ?? 1)

  // One row per distinct institution seen, keyed by the same pseudonym the
  // visits reference. Built as a map so a hundred cases at one hospital emit
  // one care site rather than a hundred.
  const careSites = new Map<number, OmopCareSite>()
  const persons: OmopPerson[] = []
  const observationPeriods: OmopObservationPeriod[] = []
  const visits: OmopVisit[] = []
  const conditions: OmopCondition[] = []
  const drugs: OmopDrug[] = []
  const measurements: OmopMeasurement[] = []
  const procedures: OmopProcedure[] = []
  // Trailing underscore because "devices" is already the local name for the
  // airway device codes read off a case further down.
  const devices_: OmopDevice[] = []
  const observations: OmopObservation[] = []
  const mappingSummary = { mapped_rows: 0, manually_curated_rows: 0, rejected_rows: 0, source_only_rows: 0, unmapped_rows: 0 }

  const trackMapping = (status: string | null | undefined) => {
    if (status === "MAPPED") mappingSummary.mapped_rows++
    // A mapping a human reviewed and signed off counts as mapped, because the
    // concept is applied either way, and is also counted on its own: an
    // automatic string match and a curated mapping are different levels of
    // evidence, and a summary that reports only "mapped" invites a reader to
    // trust a similarity score as if a clinician had checked it.
    else if (status === "MANUALLY_CURATED") { mappingSummary.mapped_rows++; mappingSummary.manually_curated_rows++ }
    // Rejected is not unmapped. Unmapped means nobody has looked; rejected
    // means someone looked and said no, and the export must not present the
    // two as the same backlog.
    else if (status === "REJECTED") mappingSummary.rejected_rows++
    else if (status === "UNMAPPED") mappingSummary.unmapped_rows++
    else if (status === "SOURCE_ONLY") mappingSummary.source_only_rows++
  }

  const sourceValue = (prefix: string, sourceVocabulary?: string | null, sourceCode?: string | null, label?: string | null) =>
    sourceVocabulary && sourceCode ? `${sourceVocabulary}:${sourceCode}${label ? ` - ${label}` : ""}` : `${prefix}:${label ?? "unknown"}`

  for (const c of cases) {
    const personId = pseudonymId("person", c.id)
    const visitId  = pseudonymId("visit", c.id)
    // Prefer the real instants. The legacy startTime/endTime columns hold a bare
    // wall clock on a dummy date (2000-01-01) with no zone, so using them as a
    // date would export the year 2000 for every legacy case; fall back to
    // createdAt instead, which is at least a genuine moment. Never emit the
    // dummy date as if it were the day of surgery.
    const legacyDay = (d: Date | null | undefined) =>
      d && d.getUTCFullYear() > 2000 ? d : null
    const startInstant = c.intraop?.startedAt ?? legacyDay(c.intraop?.startTime) ?? c.createdAt
    const endInstant   = c.intraop?.endedAt ?? legacyDay(c.intraop?.endTime) ?? c.intraop?.startedAt ?? c.createdAt
    const startDate = isoDate(startInstant)
    const endDate   = isoDate(endInstant)
    // The same instants, kept at full precision. Anaesthesia start/end is a
    // clock time, not just a day -- case duration, turnover and first-case
    // metrics all need it -- but visit_occurrence only ever carried the
    // truncated date.
    const startDateTime = startInstant ? startInstant.toISOString() : null
    const endDateTime   = endInstant ? endInstant.toISOString() : null

    // The case's own institution, stamped at creation and never updated,
    // because a case belongs to the institution it was performed at — see
    // access-control.ts, which scopes reads the same way.
    //
    // There is deliberately no fallback to the author's institution. That was
    // joined live at export time, so a case with no institution of its own was
    // attributed to wherever its author happened to work on the day of the
    // export, and could move hospital between two exports because a colleague
    // changed jobs. It also mixed two kinds of value in one column: an id from
    // the case, a name from the user. Unknown now stays unknown.
    const careSite = c.institutionId ?? null
    const careSiteId = careSite ? pseudonymId("caresite", careSite) : null
    if (careSite && careSiteId && !careSites.has(careSiteId)) {
      careSites.set(careSiteId, {
        care_site_id: careSiteId,
        // LOSPOR records the institution, not the department or theatre, so
        // there is no name beyond the source identifier and no reviewed
        // place-of-service concept to claim.
        care_site_name: null,
        place_of_service_concept_id: 0,
        care_site_source_value: careSite,
      })
    }

    // ── PERSON ───────────────────────────────────────────────────────────────
    // One person per case: LOSPOR deliberately stores no patient identifier, so
    // the same patient returning for a second operation cannot be recognised.
    // Documented as a research limitation, not an accident.
    // 8507/8532 are the OMOP standard gender concepts. OTHER and UNKNOWN both
    // fall through to 0 ("no matching concept"), but they mean different things
    // in the source data and are preserved verbatim in gender_source_value.
    const GENDER_CONCEPT: Record<string, number> = { MALE: 8507, FEMALE: 8532 }
    const ageAtOp = c.preop?.ageYears
      ?? (c.preop?.ageApproxDays != null ? Math.floor(c.preop.ageApproxDays / 365.2425) : null)
    const opYear = startDate ? Number(startDate.substring(0, 4)) : null
    persons.push({
      person_id:            personId,
      // 0 = "no matching concept", the OMOP convention for unknown/other.
      gender_concept_id:    (c.preop?.sex && GENDER_CONCEPT[c.preop.sex]) || 0,
      // Only age-in-years is collected, so the birth year is approximate (±1)
      // and month/day are genuinely unknown rather than defaulted.
      year_of_birth:        (ageAtOp != null && opYear != null) ? opYear - ageAtOp : null,
      month_of_birth:       null,
      day_of_birth:         null,
      birth_datetime:       null,
      race_concept_id:      0,   // not collected
      ethnicity_concept_id: 0,   // not collected
      person_source_value:  `RC-${c.researchId}`,
      gender_source_value:  c.preop?.sex ?? null,
    })

    // ── OBSERVATION_PERIOD ───────────────────────────────────────────────────
    // Spans the operation itself: the only window in which this pseudonymous
    // person is observed. OHDSI cohort tooling requires this to exist.
    observationPeriods.push({
      observation_period_id:         pseudonymId("obsperiod", c.id),
      person_id:                     personId,
      observation_period_start_date: startDate,
      observation_period_end_date:   endDate ?? startDate,
      period_type_concept_id:        32817, // EHR
    })

    // ── VISIT_OCCURRENCE ─────────────────────────────────────────────────────
    visits.push({
      visit_occurrence_id:   visitId,
      person_id:             personId,
      // 9201 Inpatient Visit, and it is a description rather than a guess:
      // LOSPOR documents admitted surgical care only. The Disposition enum
      // carries the evidence — WARD, PACU, ICU, with no home-discharge value —
      // so a patient who went home the same day cannot be recorded here at all.
      //
      // This is therefore an assumption about the register's scope, not a fact
      // read off the case. If day surgery is ever recorded, this must stop being
      // a constant and derive from the setting: 9201 inpatient, 9202
      // outpatient, 581379 day surgery. Until then, exporting 0 would be worse
      // than exporting 9201 — it would hide every visit from the OHDSI tools
      // that filter on visit type, to avoid stating something that is true.
      visit_concept_id:      9201,
      visit_start_date:      startDate,
      visit_start_datetime:  startDateTime,
      visit_end_date:        endDate,
      visit_end_datetime:    endDateTime,
      visit_type_concept_id: 32817, // EHR
      visit_source_value:    `RC-${c.researchId}`,
      care_site_source_value: careSite,
      // The reference a CDM consumer reads. Null when the case records no
      // institution, which is a real state; the source value stays alongside.
      care_site_id: careSiteId,
    })

    const sourceObservation = (
      source: string,
      value: string | number | boolean | null | undefined,
      date = startDate,
      // Where the exported text is a formatted rendering of a number — a
      // concentration written "0.5%" — the number is passed in rather than
      // parsed back out of the string.
      numericValue?: number | null,
      // A standard concept where the vocabulary has one for this finding.
      //
      // Defaulting to 0 keeps every existing caller unchanged: concept_id 0
      // means "we had nowhere standard to put this", which is honest for a
      // LOSPOR-specific observation and dishonest for one OMOP already knows.
      // The source value is kept either way — it is what the data dictionary
      // documents and what already-exported datasets are keyed by.
      conceptId = 0,
      // The answer as a concept, for a question whose answer the vocabulary
      // can state. Left 0 unless a caller passes one: a wrong coded answer is
      // worse than an uncoded one, which is the lesson of every other concept
      // on this page.
      valueConceptId = 0,
    ) => {
      if (value == null || value === "") return
      observations.push({
        observation_id: nextId(),
        person_id: personId,
        observation_concept_id: conceptId,
        value_as_concept_id: valueConceptId,
        observation_date: date,
        observation_type_concept_id: 32817,
        // A boolean is not a measurement, so it stays text only: "true" in
        // value_as_number would be indistinguishable from a score of 1.
        value_as_number: numericValue
          ?? (typeof value === "number" && Number.isFinite(value) ? value : null),
        value_as_string: String(value),
        observation_source_value: source,
        visit_occurrence_id: visitId,
      })
    }

    /**
     * A plain numeric measurement with a concept and a unit.
     *
     * For the quantities whose concept turns out to live in the Measurement
     * domain rather than Observation. Which table a value belongs in is the
     * vocabulary's decision, not a stylistic one -- a Measurement-domain
     * concept sitting in OBSERVATION is a CDM violation the OHDSI
     * data-quality checks flag, even when the value reads as an ordinary
     * number on the anaesthetic chart either way.
     */
    const sourceMeasurement = (
      source: string,
      value: number | null | undefined,
      conceptId: number,
      unitConceptId: number,
      unitSourceValue: string | null,
      date = startDate,
    ) => {
      if (value == null) return
      measurements.push({
        measurement_id:              nextId(),
        person_id:                   personId,
        measurement_concept_id:      conceptId,
        measurement_date:            date,
        measurement_datetime:        date,
        measurement_type_concept_id: 32817,
        value_as_number:             value,
        value_as_concept_id:         null,
        unit_concept_id:             unitConceptId,
        unit_source_value:           unitSourceValue,
        measurement_source_value:    source,
        value_source_value:          null,
        range_low:                   null,
        range_high:                  null,
        visit_occurrence_id:         visitId,
      })
    }

    /**
     * Whether a tracheal tube was cuffed, as the coded answer it has.
     *
     * LOINC registers "Cuffed endotracheal tube" (36311248) and "Uncuffed"
     * (36311029) as the answers to question 40771868, Artificial airway, so
     * both halves of the pair are codeable rather than the usual Yes/No
     * qualifiers -- the vocabulary names the actual clinical states here.
     *
     * The field is always one or the other when a tube was placed, so unlike
     * the tri-state history questions there is no "not asked" to preserve: a
     * null means no tube of that kind, and emits nothing.
     */
    const cuffedObservation = (source: string, cuffed: boolean | null | undefined) => {
      if (cuffed == null) return
      sourceObservation(source, cuffed, startDate, null, 40771868,
        cuffed ? 36311248 : 36311029)
    }

    /**
     * A graded airway scale as a measurement: the concept is the scale, the
     * grade is the coded answer, and the original grade text stays in
     * value_source_value so the Cook subdivision of Cormack-Lehane II is not
     * lost when SNOMED collapses IIa and IIb to grade 2.
     */
    const emitAirwayGrade = (
      key: keyof typeof AIRWAY_GRADES,
      grade: string | null | undefined,
      date: string | null,
      notAssessable: boolean,
    ) => {
      if (grade == null && !notAssessable) return
      const cfg = AIRWAY_GRADES[key]
      const graded = grade == null ? null : cfg.grades[grade] ?? null
      measurements.push({
        measurement_id:              nextId(),
        person_id:                   personId,
        measurement_concept_id:      cfg.concept_id,
        measurement_date:            date,
        measurement_datetime:        date,
        measurement_type_concept_id: 32817,
        value_as_number:             null,
        value_as_concept_id: grade == null
          ? (key === "mallampati" ? MALLAMPATI_NOT_ASSESSABLE_CONCEPT_ID : UNOBTAINABLE_CONCEPT_ID)
          : graded,
        unit_concept_id:             0,
        unit_source_value:           null,
        measurement_source_value:    cfg.source,
        value_source_value:          grade ?? null,
        range_low:                   null,
        range_high:                  null,
        visit_occurrence_id:         visitId,
      })
    }

    // Clinical mode is not exported. It is provenance about how this product
    // computed a case -- which ruleset drove the calculators -- rather than a
    // fact about the patient, and the fact a researcher would want it for is
    // age, which leaves as its own measurement below. A row saying
    // "clinical_mode = PEDIATRIC" at concept 0 adds a second, weaker way to ask
    // a question age already answers exactly.
    sourceObservation("LOSPOR:CLINICAL_RULES_VERSION", c.clinicalRulesVersion)

    const preop = c.preop

    // ── Preop vitals -> MEASUREMENT ───────────────────────────────────────────
    if (preop) {
      const vitDate = isoDate(c.createdAt)
      if (preop.ageValue != null && preop.ageUnit) {
        sourceObservation("LOSPOR:AGE_AT_PROCEDURE_EXACT", `${preop.ageValue} ${preop.ageUnit}`, vitDate)
      }
      sourceObservation("LOSPOR:AGE_AT_PROCEDURE_APPROX_DAYS", preop.ageApproxDays, vitDate)
      // 3005424, Body surface area -- a Measurement-domain concept, so it
      // moves out of observation.
      sourceMeasurement("LOSPOR:BODY_SURFACE_AREA_M2", preop.bodySurfaceAreaM2, 3005424, 8617, "m2", vitDate)
      // Age as a measurement rather than an untyped observation, because it is
      // a quantity with a standard concept and a unit.
      //
      // OMOP tooling normally derives age from person.year_of_birth and a visit
      // date, and would here too -- but this register deliberately coarsens the
      // birth year, so the recorded age is the more precise of the two and is
      // worth carrying in its own right.
      if (preop.ageYears != null) {
        measurements.push({
          measurement_id:              nextId(),
          person_id:                   personId,
          measurement_concept_id:      4314456,
          measurement_date:            vitDate,
          measurement_datetime:        vitDate,
          measurement_type_concept_id: 32817,
          value_as_number:             preop.ageYears,
          value_as_concept_id:         null,
          unit_concept_id:             9448,
          unit_source_value:           "a",
          measurement_source_value:    "LOSPOR:AGE_YEARS",
          value_source_value:          String(preop.ageYears),
          range_low:                   null,
          range_high:                  null,
          visit_occurrence_id:         visitId,
        })
      }
      // Urgency is not emitted here. It is a modifier on the planned procedure
      // -- 4093606 Emergency or 4013731 Elective -- which is where a statement
      // about how an operation was performed belongs. This used to emit the
      // same fact a second time as an observation at concept 0, so a query that
      // counted both would have counted every emergency case twice. It also
      // still appears as the conventional "E" suffix on the ASA class below,
      // which is a display convention rather than a second row.
      // An RCRI criterion, and the one that is not a patient condition — the
      // other four are ordinary diagnoses and reach condition_occurrence as
      // themselves. RCRI defines this by operation type (intraperitoneal,
      // intrathoracic, suprainguinal vascular), which SNOMED has no concept
      // for; this is the nearest and says "at increased risk" rather than
      // "high-risk operation", so it is an approximation and the dictionary
      // says so. It stays an observation because urgency owns the procedure's
      // modifier column, and because a statement about risk is about the
      // patient rather than about how the operation was performed.
      sourceObservation("LOSPOR:HIGH_RISK_SURGERY", preop.highRiskSurgery, vitDate, null, 4250613)
      sourceObservation("LOSPOR:POVOC_SCORE", preop.povocScore, vitDate)
      sourceObservation("LOSPOR:POVOC_RISK_PERCENT", preop.povocRiskPercent, vitDate)
      sourceObservation("LOSPOR:COLDS_SCORE", preop.coldsScore, vitDate)
      // 3031632, Fasting status - Reported: the question is coded, and the
      // JSON detail of which intervals were fasted stays in the value, since
      // no vocabulary models a per-interval fasting assessment.
      sourceObservation(
        "LOSPOR:PEDIATRIC_FASTING_ASSESSMENT",
        preop.pediatricFasting == null ? null : JSON.stringify(preop.pediatricFasting),
        vitDate,
        null,
        3031632,
      )
      // One flag can qualify more than one reading: a blood pressure that could
      // not be obtained is neither a systolic nor a diastolic, so both rows
      // carry the qualifier. Height and weight have no flag — a case cannot
      // reach the intraoperative form without them.
      const vitalMap: [keyof typeof VITAL_CONCEPTS, number | null | undefined, boolean][] = [
        ["systolic",        preop.bpSystolic,      Boolean(preop.bpUnobtainable)],
        ["diastolic",       preop.bpDiastolic,     Boolean(preop.bpUnobtainable)],
        ["heartRate",       preop.heartRate,       Boolean(preop.heartRateUnobtainable)],
        ["spO2",            preop.spO2,            Boolean(preop.spO2Unobtainable)],
        ["temp",            preop.temperature,     Boolean(preop.temperatureUnobtainable)],
        ["respiratoryRate", preop.respiratoryRate, Boolean(preop.respiratoryRateUnobtainable)],
        ["heightCm",        preop.heightCm,        false],
        ["weightKg",        preop.weightKg,        false],
      ]
      for (const [key, val, unobtainable] of vitalMap) {
        // A recorded value wins over the flag: if a number is present the
        // measurement was obtained, whatever the tickbox says.
        if (val == null && !unobtainable) continue
        const cfg = VITAL_CONCEPTS[key]
        measurements.push({
          measurement_id:            nextId(),
          person_id:                 personId,
          measurement_concept_id:    cfg.concept_id,
          measurement_date:          vitDate,
          measurement_datetime:      vitDate,
          measurement_type_concept_id: 32817,
          value_as_number:           val ?? null,
          value_as_concept_id:       val == null ? UNOBTAINABLE_CONCEPT_ID : null,
          unit_concept_id:           cfg.unitConceptId,
          unit_source_value:         cfg.unit,
          measurement_source_value:  `LOINC:${cfg.loinc}`,
          // Vitals carry no source text and no laboratory reference range.
          value_source_value:        null,
          range_low:                 null,
          range_high:                null,
          visit_occurrence_id:       visitId,
        })
      }

      // ── Lab results from LabResult rows -> MEASUREMENT ────────────────────
      // Use SQL LabResult rows (LOINC-coded) instead of raw JSON
      const labRows = preop.labRows ?? []
      for (const lab of labRows) {
        // A result with neither a number nor text is not a result. Anything
        // else is exported: this used to skip every row without a parsed
        // number, so a qualitative result -- a blood group, a culture, a
        // dipstick -- was dropped with no trace that it had been recorded.
        if (lab.valueNum == null && !lab.value) continue
        trackMapping(lab.mappingStatus)
        const labSource = lab.loincCode ? `LOINC:${lab.loincCode}` : `LAB:${lab.test}`
        measurements.push({
          measurement_id:              nextId(),
          person_id:                   personId,
          measurement_concept_id:      lab.standardConceptId ?? 0,
          measurement_date:            vitDate,
          measurement_datetime:        vitDate,
          measurement_type_concept_id: 32817,
          value_as_number:             lab.valueNum,
          value_as_concept_id: null,
          unit_concept_id:             lab.unitCanon ? LAB_UNIT_CONCEPTS[lab.unitCanon] ?? 0 : 0,
          unit_source_value:           lab.unitCanon ?? null,
          measurement_source_value:    labSource,
          // The value as the lab reported it. For a numeric result this is the
          // unparsed original; for a qualitative one it is the only value there
          // is.
          value_source_value:          lab.value ?? null,
          // The range this result was judged against. Reference ranges differ
          // by laboratory, assay and patient age, so "high" is not a claim the
          // export can support without carrying the range that produced it.
          range_low:                   lab.referenceLow ?? null,
          range_high:                  lab.referenceHigh ?? null,
          visit_occurrence_id:         visitId,
        })
        // CDM 5.4 has no abnormal-flag column, and value_as_concept_id would
        // need a standard concept this export does not assign. The flag is
        // LOSPOR's own judgement, so it is carried as its own observation,
        // keyed by the same source value the measurement row uses.
        if (lab.abnormalFlag) {
          sourceObservation("LOSPOR:LAB_ABNORMAL_FLAG", `${labSource}=${lab.abnormalFlag}`, vitDate)
        }
      }

      // ── Comorbidities -> CONDITION_OCCURRENCE ─────────────────────────────
      for (const co of preop.comorbidityRows ?? []) {
        trackMapping(co.mappingStatus)
        conditions.push({
          condition_occurrence_id:    nextId(),
          person_id:                 personId,
          condition_concept_id:      co.standardConceptId ?? 0,
          condition_start_date:      isoDate(c.createdAt),
          condition_type_concept_id: 32817,
          condition_source_value:    sourceValue("COMORBIDITY", co.sourceVocabulary, co.sourceCode, co.labelEn ?? co.labelBg ?? co.label),
          visit_occurrence_id:       visitId,
        })
      }

      // Primary diagnosis -> CONDITION_OCCURRENCE
      const diagRows = preop.diagnoses ?? []
      if (diagRows.length > 0) {
        for (const diag of diagRows) {
          trackMapping(diag.mappingStatus)
          conditions.push({
            condition_occurrence_id:    nextId(),
            person_id:                 personId,
            condition_concept_id:      diag.standardConceptId ?? 0,
            condition_start_date:      isoDate(c.createdAt),
            condition_type_concept_id: 32817,
            condition_source_value:    sourceValue("DIAGNOSIS", diag.sourceVocabulary, diag.sourceCode, diag.labelEn ?? diag.labelBg ?? diag.label),
            visit_occurrence_id:       visitId,
          })
        }
      } else if (preop.diagnosis) {
        conditions.push({
          condition_occurrence_id:    nextId(),
          person_id:                 personId,
          condition_concept_id:      0,
          condition_start_date:      isoDate(c.createdAt),
          condition_type_concept_id: 32817,
          condition_source_value:    preop.diagnosis,
          visit_occurrence_id:       visitId,
        })
      }

      // ── Observations: ASA, RCRI, Apfel, STOP-BANG, airway ───────────────
      const preopDate = isoDate(c.createdAt)
      if (preop.asaScore) {
        measurements.push({
          measurement_id:              nextId(),
          person_id:                   personId,
          // The scale, with the class as a coded answer — the same shape the
          // airway grades use, and the shape ASA has in SNOMED.
          //
          // This replaces observation_concept_id 4173987, which was on every
          // exported ASA class and is "Ethacrynic acid overdose". It is a
          // standard, valid concept, so nothing automated objected; only
          // reading the concept's name catches it. Every existing dataset
          // carries that error and is keyed by LOSPOR:ASA_CLASS, which is why
          // the source value is unchanged.
          measurement_concept_id:      4199571,
          measurement_date:            preopDate,
          measurement_datetime:        preopDate,
          measurement_type_concept_id: 32817,
          value_as_number:             null,
          value_as_concept_id:         ASA_CLASS_CONCEPTS[String(preop.asaScore)] ?? 0,
          unit_concept_id:             0,
          unit_source_value:           null,
          range_low:                   null,
          range_high:                  null,
          // The E suffix is kept as reported, but it is not what carries the
          // urgency: emergencySurgery exports separately as a procedure. There
          // is no ASA-with-E concept, and inventing one from the two would be a
          // claim the vocabulary does not make.
          value_source_value:       preop.asaScore + (preop.emergencySurgery ? "E" : ""),
          measurement_source_value: "LOSPOR:ASA_CLASS",
          visit_occurrence_id:      visitId,
        })
      }
      // The risk scores are counts of risk factors: they are summed, banded and
      // thresholded, so they belong in value_as_number.
      // Two of the five scores have a concept of their own, so they leave as
      // measurements a tool can find. SNOMED models each as a single scale with
      // no decomposition — there is no concept for "RCRI criterion 2" — which
      // is why the criteria themselves are exported as the ordinary conditions
      // they are, and reconstructing the score means looking for those.
      for (const [key, concept, value] of [
        ["LOSPOR:RCRI", 40488922, preop.rcriScore],
        ["LOSPOR:STOP_BANG", 46286812, preop.stopBangScore],
      ] as const) {
        if (value == null) continue
        measurements.push({
          measurement_id:              nextId(),
          person_id:                   personId,
          measurement_concept_id:      concept,
          measurement_date:            preopDate,
          measurement_datetime:        preopDate,
          measurement_type_concept_id: 32817,
          value_as_number:             value,
          value_as_concept_id:         0,
          unit_concept_id:             0,
          unit_source_value:           null,
          range_low:                   null,
          range_high:                  null,
          value_source_value:          String(value),
          measurement_source_value:    key,
          visit_occurrence_id:         visitId,
        })
      }
      // Apfel, POVOC and COLDS have no concept in any vocabulary here — the
      // near matches are all postoperative vomiting itself, which is the
      // outcome these predict rather than the prediction. They stay source
      // values, and their components are the route to making them poolable.
      sourceObservation("LOSPOR:APFEL", preop.apfelScore, preopDate)
      // Recorded for yes and for no, but not when nobody asked.
      //
      // This used to emit only on true, and that was right at the time: the
      // column was Boolean @default(false), so a false meant "either answered
      // no, or never touched" and exporting it would have asserted "no
      // difficult airway history" for every patient nobody had asked. Silence
      // was the honest option when the schema could not tell them apart.
      //
      // The column is now nullable, so false is an answer and null is the
      // absence of one. sourceObservation already skips null and writes false,
      // so an answered "no" finally reaches the export as a finding rather than
      // being rounded off to silence.
      // The finding as the question, answered Yes or No.
      //
      // The vocabulary's own shape for a history is a pair — "History of
      // difficult intubation" (4175851) maps to "History of event" with this
      // concept as the value — and it is not used here, deliberately. That pair
      // can only say a difficult intubation happened; a documented "no known
      // difficult airway" would have to be expressed by the absence of a row,
      // which is indistinguishable from never having asked.
      //
      // For this field that distinction is the point. A previous difficult
      // intubation outweighs every bedside test, so an anaesthetist who asked
      // and was told no has recorded something another anaesthetist will rely
      // on, and it has to survive the export as a finding rather than a gap.
      sourceObservation("LOSPOR:DIFFICULT_AIRWAY_HISTORY", preop.difficultAirwayHistory, preopDate, null, 37397718,
        preop.difficultAirwayHistory ? YES_CONCEPT_ID : NO_CONCEPT_ID)
      // Mallampati is a graded scale: the grade is the answer, so it goes in
      // value_as_concept_id rather than being flattened to text. SNOMED has a
      // dedicated concept for a score that could not be assessed, which is more
      // specific than the generic Unobtainable qualifier and is used instead.
      emitAirwayGrade("mallampati", preop.mallampati, preopDate, Boolean(preop.airwayUnobtainable))

      // ── Preop findings that used to be read and discarded ────────────────
      //
      // All of this was selected out of the database, carried through the
      // mapper's row types, and written to no table. Smoking status is the
      // plainest example: a register exists partly to study it, and it left
      // the appliance nowhere at all.
      //
      // Everything below follows the same rule as the airway history above --
      // an answered "no" is a finding and reaches the export, and only an
      // unasked question stays silent.
      // Tobacco smoking status. The field is a plain yes/no, which is what this
      // register records, so the answer stays in value_as_string rather than
      // being forced into a smoker/former/never value concept it does not have.
      // Tobacco smoking status, answered Yes or No rather than with a value
      // concept of its own. "Never smoked" would assert what the form did not
      // ask: this boolean means "not currently smoking", which is true of the
      // never-smoker and the ex-smoker alike, and they carry different
      // perioperative risk.
      sourceObservation("LOSPOR:SMOKING", preop.smoking, preopDate, null, 43054909,
        preop.smoking ? YES_CONCEPT_ID : NO_CONCEPT_ID)
      // Answered Yes or No rather than asserted, so a denial is recorded as a
      // denial and an unasked question stays absent.
      sourceObservation("LOSPOR:SUBSTANCE_ABUSE", preop.substanceAbuse, preopDate, null, 4234597,
        preop.substanceAbuse ? YES_CONCEPT_ID : NO_CONCEPT_ID)
      // One row, answered Yes or No.
      //
      // The question concept comes from the non-standard "Allergy to latex"
      // (604826) through its Maps to. That source concept also has a Maps to
      // value — the RxNorm ingredient — and the OHDSI convention is to put both
      // halves in one row: the target concept in the question, the value
      // concept in the answer. An earlier attempt here emitted them as two
      // rows, which is not what the pair means and made one latex-allergic
      // patient count twice under observation_concept_id 43530807.
      //
      // The allergen is therefore in the source value rather than coded, which
      // is the cost of answering Yes or No instead. It is worth paying: a
      // denial is a documented safety check a theatre acts on, and coding the
      // substance in the answer would leave "latex allergy: no" with nothing to
      // say and no way to tell it from a question nobody asked.
      sourceObservation("LOSPOR:LATEX_ALLERGY", preop.latexAllergy, preopDate, null, 43530807,
        preop.latexAllergy ? YES_CONCEPT_ID : NO_CONCEPT_ID)
      // "Complication of anesthesia" rather than malignant hyperthermia, which
      // is what this used to carry. The question is the broader one a
      // pre-assessment asks — it catches suxamethonium apnoea, a family
      // pattern of difficult intubation, severe PONV — and coding all of that
      // as an MH history would put a specific and frightening claim on records
      // where the family reported something else. The detail beside it carries
      // what was actually reported.
      sourceObservation("LOSPOR:FAMILY_ANAESTHESIA_PROBLEMS", preop.familyAnesthesiaProblems, preopDate, null, 764557,
        preop.familyAnesthesiaProblems ? YES_CONCEPT_ID : NO_CONCEPT_ID)
      sourceObservation("LOSPOR:FAMILY_ANAESTHESIA_DETAILS", preop.familyAnesthesiaDetails, preopDate)
      // "Dental prosthesis" rather than any of the denture concepts, because
      // the question is broader than dentures: crowns, caps and bridges are
      // what a laryngoscope chips, and dental damage is the commonest claim
      // against an anaesthetist. A denture-specific concept would miss the
      // patient with anterior crowns, who is the higher risk of the two.
      sourceObservation("LOSPOR:DENTAL_PROSTHETICS", preop.dentalProsthetics, preopDate, null, 3029182,
        preop.dentalProsthetics ? YES_CONCEPT_ID : NO_CONCEPT_ID)
      // "Abnormal tooth mobility", which is what the question means and what
      // makes a No worth recording: no abnormal mobility found. The neutral
      // "Tooth mobility" concept would leave a No saying nothing.
      sourceObservation("LOSPOR:LOOSE_TEETH", preop.looseTeeth, preopDate, null, 4002000,
        preop.looseTeeth ? YES_CONCEPT_ID : NO_CONCEPT_ID)
      // The umbrella, which is the level the question asks at: atrial
      // fibrillation, flutter, block and ectopics all answer it. "Irregular
      // heart beat" is what a patient reports rather than what a
      // pre-assessment records, and the irregularly-irregular pulse is one
      // arrhythmia rather than the class.
      sourceObservation("LOSPOR:HEART_ARRHYTHMIA", preop.heartArrhythmia, preopDate, null, 44784217,
        preop.heartArrhythmia ? YES_CONCEPT_ID : NO_CONCEPT_ID)

      // The allergy flag already reaches DRUG_ALLERGY observations per
      // substance, but the free-text detail carries allergens that were never
      // resolved to a drug -- redacted upstream like every other note.
      sourceObservation("LOSPOR:ALLERGY_DETAILS", preop.allergyDetails, preopDate)

      // Body mass index is stored, not derived at export time, because the
      // height and weight it was computed from may since have been corrected.
      // Body mass index as a measurement rather than an observation, because it
      // is a quantity with a standard concept and a unit. Stored rather than
      // recomputed at export time, since the height and weight it came from may
      // since have been corrected.
      if (preop.bmi != null) {
        measurements.push({
          measurement_id:              nextId(),
          person_id:                   personId,
          measurement_concept_id:      4245997,
          measurement_date:            preopDate,
          measurement_datetime:        preopDate,
          measurement_type_concept_id: 32817,
          value_as_number:             preop.bmi,
          value_as_concept_id:         0,
          // 9531, UCUM kg/m2.
          unit_concept_id:             9531,
          unit_source_value:           "kg/m2",
          range_low:                   null,
          range_high:                  null,
          value_source_value:          String(preop.bmi),
          measurement_source_value:    "LOSPOR:BMI",
          visit_occurrence_id:         visitId,
        })
      }

      // ABO and Rh as one fact, which is how a blood group is read and how a
      // crossmatch query wants it. Two rows would say "group A" and "Rh
      // positive" as separate findings, and SNOMED has a concept for each of
      // the eight combinations, so there is no reason to split them.
      const bloodGroupConcept = bloodGroupConceptFor(preop.bloodType, preop.rhFactor)
      if (preop.bloodType || preop.rhFactor) {
        const groupText = `${preop.bloodType ?? "?"}${
          preop.rhFactor === "POSITIVE" ? "+" : preop.rhFactor === "NEGATIVE" ? "-" : "?"}`
        measurements.push({
          measurement_id:              nextId(),
          person_id:                   personId,
          measurement_concept_id:      3003694,
          measurement_date:            preopDate,
          measurement_datetime:        preopDate,
          measurement_type_concept_id: 32817,
          value_as_number:             null,
          // 0 when only one half was recorded: "A, Rh unknown" is not one of
          // the eight, and guessing the other half would invent a crossmatch.
          value_as_concept_id:         bloodGroupConcept,
          unit_concept_id:             0,
          unit_source_value:           null,
          range_low:                   null,
          range_high:                  null,
          value_source_value:          groupText,
          measurement_source_value:    "LOSPOR:BLOOD_GROUP",
          visit_occurrence_id:         visitId,
        })
      }
      sourceObservation("LOSPOR:GUTA_SCORE", preop.gutaScore, preopDate)

      // ── The airway examination ───────────────────────────────────────────
      //
      // Distinct from the difficult-airway history: this is what the
      // anaesthetist found on examining this patient, and it is what a
      // predictive study needs alongside the Cormack-Lehane grade the intraop
      // record now carries.
      // The two airway distances are quantities with standard concepts, so they
      // are measurements now rather than LOSPOR-only observations. When the
      // examination could not be performed they carry the same Unobtainable
      // qualifier the vitals use.
      const airwayNotAssessable = Boolean(preop.airwayUnobtainable)
      const airwayDistances: [keyof typeof AIRWAY_MEASUREMENTS, number | null | undefined][] = [
        ["mouthOpeningCm", preop.mouthOpeningCm],
        ["thyromental", preop.thyromental],
      ]
      for (const [key, val] of airwayDistances) {
        if (val == null && !airwayNotAssessable) continue
        const cfg = AIRWAY_MEASUREMENTS[key]
        measurements.push({
          measurement_id:              nextId(),
          person_id:                   personId,
          measurement_concept_id:      cfg.concept_id,
          measurement_date:            preopDate,
          measurement_datetime:        preopDate,
          measurement_type_concept_id: 32817,
          value_as_number:             val ?? null,
          value_as_concept_id:         val == null ? UNOBTAINABLE_CONCEPT_ID : null,
          unit_concept_id:             cfg.unitConceptId,
          unit_source_value:           cfg.unit,
          measurement_source_value:    cfg.source,
          value_source_value:          null,
          range_low:                   null,
          range_high:                  null,
          visit_occurrence_id:         visitId,
        })
      }
      // Neck mobility as a graded scale, like the other airway grades: the
      // examination is the question and the range found is the coded answer.
      // SNOMED's cervical-movement values are an exact fit for the three the
      // form offers, and an unassessable airway takes the same Unobtainable
      // qualifier the distances above use rather than the string it carried.
      if (preop.neckMobility != null || airwayNotAssessable) {
        measurements.push({
          measurement_id:              nextId(),
          person_id:                   personId,
          measurement_concept_id:      4039256,
          measurement_date:            preopDate,
          measurement_datetime:        preopDate,
          measurement_type_concept_id: 32817,
          value_as_number:             null,
          value_as_concept_id: preop.neckMobility == null
            ? UNOBTAINABLE_CONCEPT_ID
            : NECK_MOBILITY_CONCEPTS[preop.neckMobility] ?? 0,
          unit_concept_id:             0,
          unit_source_value:           null,
          measurement_source_value:    "LOSPOR:NECK_MOBILITY",
          value_source_value:          preop.neckMobility ?? null,
          range_low:                   null,
          range_high:                  null,
          visit_occurrence_id:         visitId,
        })
      }
      // The upper lip bite test has no concept in any vocabulary here. Two
      // searches, lexical and semantic, returned nothing above 0.75 and the
      // best of those was "Functional tests in the oral cavity" — a French
      // procedure code for something else. It stays a source value.
      sourceObservation("LOSPOR:UPPER_LIP_BITE_TEST", preop.upperLipBiteTest, preopDate)
      if (airwayNotAssessable) {
        // The upper lip bite test has no standard concept, so its
        // unassessability is carried the way its values are — as a source
        // value. Neck mobility no longer needs this: it carries the
        // Unobtainable qualifier in its own row above.
        sourceObservation("LOSPOR:UPPER_LIP_BITE_TEST", "unobtainable", preopDate)
      }
      sourceObservation("LOSPOR:RETROGNATHIA", preop.retrognathia, preopDate, null, 4142490,
        preop.retrognathia ? YES_CONCEPT_ID : NO_CONCEPT_ID)
      // "Protrusion of tooth", which is the finding the assessor made. An
      // earlier pass here concluded no concept existed and left this at 0; that
      // was a search that only tried dysmorphology phrasings and came back with
      // HPO entries this product does not ship. The plain SNOMED term was there
      // the whole time.
      //
      // Not "Horizontal overbite", which is the orthodontic measurement every
      // mouth has some of, and not "Prominent maxilla", which is the jaw rather
      // than the teeth the laryngoscope meets.
      sourceObservation("LOSPOR:PROMINENT_INCISORS", preop.prominentIncisors, preopDate, null, 4033016,
        preop.prominentIncisors ? YES_CONCEPT_ID : NO_CONCEPT_ID)
      // Deliberately uncoded, and this is the record of why rather than an
      // omission waiting to be tidied up.
      //
      // The vocabulary has nothing for facial hair as a clinical finding. What
      // it has is anatomy — "Structure of beard hair" — which would say
      // "beard hair structure: present" and be looked for by nobody. The
      // tempting bridge is "Failed mask ventilation", which is standard and
      // real and would be flatly false: that is an outcome, and a beard is a
      // predictor of one.
      //
      // A beard is recorded here for exactly one reason, mask seal, and the
      // conclusion it feeds — whether difficulty is anticipated — is the thing
      // worth coding. This stays a source value beneath it.
      sourceObservation("LOSPOR:FACIAL_HAIR", preop.facialHair, preopDate)
      sourceObservation("LOSPOR:DIFFICULT_AIRWAY_NOTES", preop.difficultAirwayNotes, preopDate)
      // "At increased risk for difficult tracheal intubation" rather than
      // "Expected difficult tracheal intubation", which is the closer wording
      // and the weaker claim. What the assessor puts in this box is a
      // prediction from bedside tests, and bedside tests predict poorly: most
      // patients flagged here are intubated without trouble. A risk statement
      // is what the evidence supports, and it is also what stays true when the
      // intubation turns out to be easy -- an expectation the case then
      // contradicts reads, in a database, like an error rather than a
      // precaution that paid off.
      //
      // Its outcome counterpart is 37397717, Unexpected difficult airway, which
      // nothing writes yet.
      sourceObservation("LOSPOR:ANTICIPATED_DIFFICULT_AIRWAY", preop.anticipatedDifficultAirway, preopDate, null,
        37159176, preop.anticipatedDifficultAirway ? YES_CONCEPT_ID : NO_CONCEPT_ID)
      // Malignant hyperthermia in this patient, as distinct from the family
      // history above. A personal MH history is the one anaesthetic fact that
      // changes the whole plan -- no volatile agent, no suxamethonium, a
      // flushed machine -- and it had no field at all until now, so a patient
      // who told the assessor could only have it written into free text.
      sourceObservation("LOSPOR:MALIGNANT_HYPERTHERMIA_HISTORY", preop.malignantHyperthermiaHistory, preopDate, null,
        440285, preop.malignantHyperthermiaHistory ? YES_CONCEPT_ID : NO_CONCEPT_ID)
      // "Complication due to anesthesia during surgery" -- the operative
      // setting is part of what is being asked. The unqualified umbrella
      // (4142195) would also admit a reaction to a dental local, which is a
      // different and much weaker signal than something going wrong in theatre.
      //
      // The field exists for the events nobody could explain afterwards, so it
      // is deliberately not coded as a drug reaction: naming a cause is exactly
      // what the record cannot do.
      sourceObservation("LOSPOR:UNEXPLAINED_ANAESTHESIA_COMPLICATIONS", preop.unexplainedAnaesthesiaComplications,
        preopDate, null, 37017043,
        preop.unexplainedAnaesthesiaComplications ? YES_CONCEPT_ID : NO_CONCEPT_ID)
    }

    // ── Planned procedure -> PROCEDURE_OCCURRENCE ─────────────────────────────
    // Every planned procedure, not just the first. This read procedureRows[0]
    // and discarded the rest silently: a case with two planned procedures
    // exported one, with nothing to show the others had been dropped. A
    // combined operation therefore appeared in the register as a lesser one.
    //
    // The unstructured plannedProcedure text is the fallback for cases recorded
    // before procedure rows existed, and only when there are no rows at all.
    // Urgency, hung off the operation rather than emitted as an operation of
    // its own. As its own procedure_occurrence row it would make one
    // appendectomy count as two and add a spurious hit to any cohort defined
    // over a procedure concept set.
    //
    // SNOMED Qualifier Values, which is the concept class a modifier column is
    // for: Emergency 4093606 against Elective 4013731. The obvious-looking
    // "Emergency procedure" (4158569) is Procedure-domain — it names an
    // operation, not a way of performing one, and would have put a second
    // procedure concept in a qualifier slot. Urgent (4014167) and Routine
    // (4176260) are the same class if the form ever needs them.
    //
    // The two are one toggle in the form and cannot both be true, which is what
    // lets a single column carry the whole dimension. A case recorded before
    // the field existed has neither, and takes 0: unmodified, rather than a
    // guess that it was elective.
    const emergency = preop?.emergencySurgery
    const surgicalUrgencyConcept = emergency == null ? 0 : emergency ? 4093606 : 4013731
    const surgicalUrgencySource = emergency == null
      ? null
      : emergency ? "LOSPOR:EMERGENCY_SURGERY" : "LOSPOR:ELECTIVE_SURGERY"

    const procedureRows = preop?.procedureRows ?? []
    if (procedureRows.length > 0) {
      for (const row of procedureRows) {
        trackMapping(row.mappingStatus)
        procedures.push({
          procedure_occurrence_id:    nextId(),
          person_id:                 personId,
          procedure_concept_id:      row.standardConceptId ?? 0,
          procedure_date:            startDate,
          procedure_type_concept_id: 32817,
          modifier_concept_id:       surgicalUrgencyConcept,
          modifier_source_value:     surgicalUrgencySource,
          procedure_source_value:    sourceValue("PROCEDURE", row.sourceVocabulary, row.sourceCode, row.group ?? row.description),
          visit_occurrence_id:       visitId,
        })
      }
    } else if (preop?.plannedProcedure) {
      procedures.push({
        procedure_occurrence_id:    nextId(),
        person_id:                 personId,
        procedure_concept_id:      0,
        procedure_date:            startDate,
        procedure_type_concept_id: 32817,
        modifier_concept_id:       surgicalUrgencyConcept,
        modifier_source_value:     surgicalUrgencySource,
        procedure_source_value:    preop.plannedProcedure,
        visit_occurrence_id:       visitId,
      })
    }

    // ── Intraop techniques -> PROCEDURE_OCCURRENCE ────────────────────────────
    for (const med of preop?.medications ?? []) {
      trackMapping(med.mappingStatus)
      // Medication.kind is CURRENT | ALLERGY, and they are opposite claims: one
      // says the patient takes this drug, the other says they must never be
      // given it. Both used to become DRUG_EXPOSURE, which asserts
      // administration — so an allergy was exported as a dose, in the dangerous
      // direction, and no downstream query could tell it apart from a real one.
      //
      // The allergy is not dropped. It becomes an observation carrying the
      // substance, because "no allergy recorded" and "allergy lost on export"
      // must not look identical to a researcher.
      if (med.kind === "ALLERGY") {
        sourceObservation(
          "LOSPOR:DRUG_ALLERGY",
          sourceValue("MEDICATION", med.sourceVocabulary, med.sourceCode, med.nameRaw),
          isoDate(c.createdAt),
        )
        continue
      }
      // Not `parseFloat(med.dose) || null`: that turns a recorded dose of 0
      // into "not recorded", the same class of bug the fluid figures below
      // were tested against and this line was not.
      const dose = numOrNull(med.dose)
      drugs.push({
        drug_exposure_id: nextId(),
        person_id: personId,
        drug_concept_id: med.standardConceptId ?? 0,
        drug_exposure_start_date: isoDate(c.createdAt),
        // A single administration, not an interval: no end to record.
        drug_exposure_end_date: null,
        // 32865, Patient self-report. This row is not a witnessed
        // administration -- it is what the patient (or an old chart) told the
        // assessor they take at home, which nobody here watched happen. That is
        // also what separates this row from a premedication or an intraop dose
        // sharing the same drug_concept_id: those are 32818, EHR administration
        // record, in the two sites below.
        drug_type_concept_id: 32865,
        drug_source_value: sourceValue("MEDICATION", med.sourceVocabulary, med.sourceCode, med.nameRaw),
        // The ATC/INN text is already carried by drug_source_value above. No
        // OMOP *source* concept is resolved for it today, so this stays null
        // rather than being filled with something that is not a concept id.
        drug_source_concept_id: null,
        dose_value: dose,
        dose_unit_source_value: doseUnitOf(med.dose),
        route_source_value: med.route,
        visit_occurrence_id: visitId,
      })
    }

    if (c.intraop) {
      // 1176109, Anesthesia duration, which is an Observation-domain concept,
      // so unlike the other numbers in this batch it stays where it already is.
      sourceObservation("LOSPOR:ANAESTHESIA_DURATION_MIN", c.intraop.durationMinutes, startDate,
        c.intraop.durationMinutes, 1176109)

      // ── Airway management ────────────────────────────────────────────────
      //
      // The device, its size and the laryngoscopic view are states of the
      // patient during the case, so they are OBSERVATIONs. Placing the device
      // is an act performed on the patient, so it is a PROCEDURE_OCCURRENCE.
      // Exporting only the first conflates the two: "an endotracheal tube was
      // present" and "this patient was intubated" are different claims, and
      // only the second belongs in a procedure count.
      //
      // Until this, none of the detail left at all. An export could say a tube
      // was placed but not which, what size, whether it was cuffed, or how
      // difficult the view was -- which is the whole substance of a
      // difficult-airway study.
      const ia = c.intraop
      const strList = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []

      // airwayDevice is the older single column; airwayDevices is the current
      // list. Both may be populated, so they are merged and de-duplicated
      // rather than one being preferred and the other silently dropped.
      const devices = [...new Set([...(ia.airwayDevice ? [ia.airwayDevice] : []), ...strList(ia.airwayDevices)])]
      // The device itself, alongside the act of placing it. Both are true and
      // they answer different questions -- see OmopDevice.
      for (const device of devices) {
        sourceObservation("LOSPOR:AIRWAY_DEVICE", device)
        devices_.push({
          device_exposure_id:         nextId(),
          person_id:                  personId,
          device_concept_id:          AIRWAY_DEVICE_CONCEPTS[device] ?? 0,
          device_exposure_start_date: startDate,
          device_exposure_end_date:   endDate,
          device_type_concept_id:     32817,
          device_source_value:        "AIRWAY_DEVICE:" + device,
          visit_occurrence_id:        visitId,
        })
      }

      // The laryngoscopy grade is what an airway-prediction study compares the
      // preoperative assessment against, so it carries its standard concept
      // rather than a LOSPOR-only code. There is no unobtainable flag on the
      // intraoperative record: an absent grade means no direct laryngoscopy.
      emitAirwayGrade("cormackLehane", ia.cormackLehane, startDate, false)
      for (const tool of strList(ia.airwayTools)) {
        sourceObservation("LOSPOR:AIRWAY_TOOL", tool)
        devices_.push({
          device_exposure_id:         nextId(),
          person_id:                  personId,
          device_concept_id:          AIRWAY_TOOL_CONCEPTS[tool] ?? 0,
          device_exposure_start_date: startDate,
          device_exposure_end_date:   endDate,
          device_type_concept_id:     32817,
          device_source_value:        "AIRWAY_TOOL:" + tool,
          visit_occurrence_id:        visitId,
        })
      }
      // 4337615, Orotracheal fiberoptic intubation. This field sits in the
      // airway-tools section, so it means fibreoptic intubation rather than
      // 604177 (Flexible bronchoscopy), which is a diagnostic procedure. The
      // oral route is asserted rather than recorded -- the form has a single
      // flag and does not say which route the scope took -- so this is a
      // product decision of the same kind as the sciatic block approach, and
      // 4337617 is the nasal counterpart if the form ever distinguishes them.
      sourceObservation("LOSPOR:FIBREOPTIC_BRONCHOSCOPY", ia.fob, startDate, null, 4337615,
        ia.fob ? YES_CONCEPT_ID : NO_CONCEPT_ID)

      // Sizes are recorded per device. The legacy tubeSize/cuffed pair is the
      // only size older rows carry, so it is exported under its own code
      // rather than being guessed onto one of the per-device ones.
      sourceObservation("LOSPOR:LMA_SIZE", ia.lmaSize)
      // 21491186, Endotracheal tube Diameter -- a Measurement-domain LOINC
      // concept, so the sizes move out of observation. The same concept covers
      // every tube whose diameter is recorded in millimetres; which tube it
      // was stays in measurement_source_value.
      sourceMeasurement("LOSPOR:ORAL_TUBE_SIZE", numOrNull(ia.oralTubeSize), 21491186, 8588, "mm")
      cuffedObservation("LOSPOR:ORAL_TUBE_CUFFED", ia.oralCuffed)
      sourceMeasurement("LOSPOR:NASAL_TUBE_SIZE", numOrNull(ia.nasalTubeSize), 21491186, 8588, "mm")
      cuffedObservation("LOSPOR:NASAL_TUBE_CUFFED", ia.nasalCuffed)
      sourceObservation("LOSPOR:DLT_TYPE", ia.dltType)
      sourceObservation("LOSPOR:DLT_SIDE", ia.dltSide)
      sourceObservation("LOSPOR:DLT_SIZE", ia.dltSize)
      sourceObservation("LOSPOR:ENDOBRONCHIAL_TUBE_SIZE", ia.endobronchialSize)
      sourceMeasurement("LOSPOR:TUBE_SIZE_LEGACY", numOrNull(ia.tubeSize), 21491186, 8588, "mm")
      cuffedObservation("LOSPOR:TUBE_CUFFED_LEGACY", ia.cuffed)

      // ── Ventilation ──────────────────────────────────────────────────────
      // 3004921, Ventilation mode Ventilator. The mode names themselves --
      // VCV, PCV, SIMV+PSV -- have no value concepts, so the mode stays in
      // value_as_string while the row gains a real question concept.
      for (const mode of strList(ia.ventilationModes)) {
        sourceObservation("LOSPOR:VENTILATION_MODE", mode, startDate, null, 3004921)
      }
      // Unqualified in both cases: the fields are plain flags, and the
      // narrower concepts assert a route or a modality neither records.
      sourceObservation("LOSPOR:IPPV", ia.ippv, startDate, null, 607086,
        ia.ippv ? YES_CONCEPT_ID : NO_CONCEPT_ID)
      sourceObservation("LOSPOR:JET_VENTILATION", ia.jetVentilation, startDate, null, 4168475,
        ia.jetVentilation ? YES_CONCEPT_ID : NO_CONCEPT_ID)
      // 3022875, the ventilator *setting*, which is what an anaesthetist
      // charts -- not 3016226, the measured airway pressure.
      sourceMeasurement("LOSPOR:PEEP_CMH2O", ia.peepCmH2O, 3022875, 44777590, "cm[H2O]")

      // ── Airway acts -> PROCEDURE_OCCURRENCE ──────────────────────────────
      //
      // Derived from the devices actually recorded, so a case documents the
      // intubation it performed and not the one it might have. Devices with no
      // corresponding act -- a face mask, a nasal cannula -- produce no
      // procedure, which is correct: nothing was placed.
      for (const device of devices) {
        const act = AIRWAY_ACTS[device]
        if (!act) continue
        procedures.push({
          procedure_occurrence_id:   nextId(),
          person_id:                 personId,
          procedure_concept_id:      AIRWAY_ACT_CONCEPTS[act] ?? 0,
          procedure_date:            startDate,
          procedure_type_concept_id: 32817,
          modifier_concept_id:       0,
          modifier_source_value:     null,
          procedure_source_value:    `AIRWAY_MANAGEMENT:${act}`,
          visit_occurrence_id:       visitId,
        })
      }

      // A technique's placement is sometimes also logged as its own
      // intraop timeline marker ("Spinal in", "Epidural in") -- the same
      // procedure, witnessed twice. Rather than emit that marker as a
      // second procedure_occurrence row (double-counting the block for any
      // cohort built on this concept), its timestamp refines the technique
      // row's own date/time instead: the technique list says a spinal was
      // done, the timeline says exactly when.
      const clinicalEventTimestamp = (label: string): Date | undefined =>
        (c.events ?? []).find(e => e.type === "clinical_event" && e.label === label)?.timestamp

      // Whether tech sits at or under the named tree node -- used to find
      // "any peripheral block" for the generic "Block done" marker, the same
      // way SPINAL/EPIDURAL are found for their own dedicated markers.
      const isUnderTechniqueNode = (tech: string, ancestor: string): boolean => {
        let node: string | undefined = tech
        const seen = new Set<string>()
        while (node && !seen.has(node)) {
          if (node === ancestor) return true
          seen.add(node)
          node = TECHNIQUE_PARENT[node]
        }
        return false
      }

      const techs: string[] = Array.isArray(c.intraop.techniques) ? c.intraop.techniques as string[] : []
      // "Block done" names no specific block, so it can only refine a
      // technique row unambiguously when exactly one peripheral block is on
      // the list -- two simultaneous blocks (e.g. bilateral) leave it unclear
      // which one the marker timed, so neither is refined.
      const peripheralBlockTechs = techs.filter(t => isUnderTechniqueNode(t, "PERIPHERAL"))
      const blockDoneTs = peripheralBlockTechs.length === 1 ? clinicalEventTimestamp("Block done") : undefined
      for (const tech of techs) {
        const techConceptId = techniqueConceptFor(tech)
        const preciseTs = techConceptId === TECHNIQUE_CONCEPTS.SPINAL ? clinicalEventTimestamp("Spinal in")
          : techConceptId === TECHNIQUE_CONCEPTS.EPIDURAL ? clinicalEventTimestamp("Epidural in")
          : (peripheralBlockTechs.length === 1 && tech === peripheralBlockTechs[0]) ? blockDoneTs
          : undefined
        procedures.push({
          procedure_occurrence_id:    nextId(),
          person_id:                 personId,
          // Coded at the level the vocabulary supports; the node the
          // anaesthetist actually chose stays in the source value.
          procedure_concept_id:      techConceptId,
          procedure_date:            preciseTs ? isoDate(preciseTs) : startDate,
          procedure_datetime:        preciseTs ? preciseTs.toISOString() : null,
          procedure_type_concept_id: 32817,
          modifier_concept_id:       0,
          modifier_source_value:     null,
          procedure_source_value:    `ANAESTHESIA_TECHNIQUE:${tech}`,
          visit_occurrence_id:       visitId,
        })
      }

      // Removing a neuraxial catheter is a distinct procedure from placing
      // one, not a second sighting of the same fact -- so unlike Spinal in/
      // Epidural in/Block done above, this is its own new row rather than a
      // refinement.
      const spinalRemovedTs = clinicalEventTimestamp("Spinal removed")
      if (spinalRemovedTs) {
        procedures.push({
          procedure_occurrence_id:    nextId(),
          person_id:                  personId,
          procedure_concept_id:       37165151, // Removal of intrathecal catheter
          procedure_date:             isoDate(spinalRemovedTs),
          procedure_datetime:         spinalRemovedTs.toISOString(),
          procedure_type_concept_id:  32817,
          modifier_concept_id:        0,
          modifier_source_value:      null,
          procedure_source_value:     "INTRAOP_EVENT:Spinal removed",
          visit_occurrence_id:        visitId,
        })
      }
      // Epidural removed has no standard concept -- searched exhaustively,
      // only non-standard CCAM/OPS results exist. Left unmapped.

      // ── Drug events from CaseEvent rows -> DRUG_EXPOSURE ─────────────────
      // Read from SQL CaseEvent rows (type="drug", status="active")
      // instead of parsing the legacy keyEvents.log JSON blob
      const drugEvents = c.events ?? []

      // When each continuous administration stopped.
      //
      // infusion_stop and agent_stop used to be skipped entirely, so every
      // infusion and every volatile exported with a start and no end — which in
      // the CDM reads as "still running". Duration, the quantity most
      // anaesthetic research is built on, could not be derived at all.
      //
      // Infusions pair by infId. Volatiles have no key because only one runs at
      // a time, so a stop closes whichever is currently open; that is exactly
      // how the intraop engine reads the same events. An administration with no
      // stop stays open, because still running when the case ended is a real
      // state and inventing an end would manufacture a duration nobody recorded.
      const ordered = [...drugEvents].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      const infusionEnd = new Map<string, Date>()
      // fluid_start/fluid_end pair by fluidId exactly the way infusions pair by
      // infId -- the app already emits fluid_end with that key
      // (lospor-core/src/intraop-engine.ts) when a fluid is stopped. This map
      // was missing entirely, so every fluid drug_exposure row exported with
      // no end date regardless of whether the fluid was actually stopped: in
      // the CDM, a null end date reads as "still running".
      const fluidEnd = new Map<string, Date>()
      const agentEnd = new Map<number, Date>()
      let openAgentIndex: number | null = null
      ordered.forEach((ev, index) => {
        if (ev.type === "infusion_stop" && ev.infId) infusionEnd.set(ev.infId, ev.timestamp)
        if (ev.type === "fluid_end" && ev.fluidId) fluidEnd.set(ev.fluidId, ev.timestamp)
        if (ev.type === "agent_start") openAgentIndex = index
        if (ev.type === "agent_stop" && openAgentIndex != null) {
          agentEnd.set(openAgentIndex, ev.timestamp)
          openAgentIndex = null
        }
      })
      const endFor = (ev: typeof drugEvents[number], index: number): string | null => {
        if (ev.type === "infusion_start") return ev.infId ? isoDate(infusionEnd.get(ev.infId)) : null
        if (ev.type === "fluid_start") return ev.fluidId ? isoDate(fluidEnd.get(ev.fluidId)) : null
        if (ev.type === "agent_start") return isoDate(agentEnd.get(index))
        return null
      }

      for (const [index, ev] of ordered.entries()) {
        if (ev.type === "vital") {
          const eventVitals: [keyof typeof VITAL_CONCEPTS, number | null | undefined, string | null | undefined][] = [
            ["systolic", ev.systolic, null],
            ["diastolic", ev.diastolic, null],
            ["heartRate", ev.heartRate, null],
            ["spO2", ev.spO2, null],
            ["etco2", ev.etco2, null],
            ["temp", ev.temp, null],
            ["bgl", ev.bgl, ev.bglLoincCode],
          ]
          for (const [key, val, loincOverride] of eventVitals) {
            if (val == null) continue
            const cfg = VITAL_CONCEPTS[key]
            measurements.push({
              measurement_id:            nextId(),
              person_id:                 personId,
              measurement_concept_id:    cfg.concept_id,
              measurement_date:          isoDate(ev.timestamp),
              measurement_datetime:      ev.timestamp.toISOString(),
              measurement_type_concept_id: 32817,
              value_as_number:           val,
              value_as_concept_id: null,
              unit_concept_id:           key === "bgl" ? (ev.bglUnitCanon ? (LAB_UNIT_CONCEPTS[ev.bglUnitCanon] ?? cfg.unitConceptId) : cfg.unitConceptId) : cfg.unitConceptId,
              unit_source_value:         key === "bgl" ? ev.bglUnitCanon ?? cfg.unit : cfg.unit,
              measurement_source_value:  `LOINC:${loincOverride ?? cfg.loinc}`,
              // Vitals carry no source text and no laboratory reference range.
              value_source_value:        null,
              range_low:                 null,
              range_high:                null,
              visit_occurrence_id:       visitId,
            })
          }
        }
        if (ev.type === "agent_start" && ev.agentPercent != null) {
          // 4354275, Inspired anesthetic agent concentration -- the dial
          // setting, which is what this records. Not 4107998 (End tidal), a
          // different measured quantity, and not the unqualified 4353943.
          // Measurement domain, so it moves out of observation.
          measurements.push({
            measurement_id:              nextId(),
            person_id:                   personId,
            measurement_concept_id:      4354275,
            measurement_date:            isoDate(ev.timestamp),
            measurement_datetime:        ev.timestamp.toISOString(),
            measurement_type_concept_id: 32817,
            value_as_number:             ev.agentPercent,
            value_as_concept_id:         null,
            unit_concept_id:             8554,
            unit_source_value:           "%",
            measurement_source_value:    "LOSPOR:VOLATILE_AGENT_PERCENT",
            value_source_value:          null,
            range_low:                   null,
            range_high:                  null,
            visit_occurrence_id:         visitId,
          })
        }
        if (ev.type === "gas_start" || ev.type === "gas_change") {
          // Split by the concept's own OMOP domain rather than emitted
          // uniformly as measurements. Fresh gas flow and inspired nitrous
          // oxide are Observation-domain concepts; putting them in MEASUREMENT
          // would be a CDM violation the OHDSI data-quality checks flag, even
          // though all four read as numbers on the same anaesthetic chart.
          //
          // FIAIR has no concept at all: SNOMED names inspired oxygen and
          // inspired nitrous oxide and stops there, so inspired air stays a
          // LOSPOR source value at 0.
          const gasMeasurements: [string, number | null | undefined, string, number][] = [
            ["LOINC:3150-0", ev.fio2Percent, "%", 3020716],
            ["LOSPOR:FIAIR_PERCENT", ev.fiAirPercent, "%", 0],
          ]
          for (const [source, val, unit, conceptId] of gasMeasurements) {
            if (val == null) continue
            measurements.push({
              measurement_id: nextId(), person_id: personId,
              measurement_concept_id: conceptId,
              measurement_date: isoDate(ev.timestamp),
              measurement_datetime: ev.timestamp.toISOString(),
              measurement_type_concept_id: 32817,
              value_as_number: val,
              value_as_concept_id: null,
              unit_concept_id: conceptId ? 8554 : 0,
              unit_source_value: unit,
              measurement_source_value: source,
              // Vitals carry no source text and no laboratory reference range.
              value_source_value:        null,
              range_low:                 null,
              range_high:                null,
              visit_occurrence_id: visitId,
            })
          }
          sourceObservation("LOSPOR:FGF_L_PER_MIN", ev.fgfLitersPerMin, isoDate(ev.timestamp),
            ev.fgfLitersPerMin, 4108006)
          sourceObservation("LOSPOR:FIN2O_PERCENT", ev.fiN2OPercent, isoDate(ev.timestamp),
            ev.fiN2OPercent, 4354273)
          sourceObservation("LOSPOR:CARRIER_GAS", ev.carrierGas, isoDate(ev.timestamp))
        }
        // fluid_start joins the administration types: the volume and category
        // were selected from the database and then discarded, leaving only case
        // totals, so when a litre went in was unanswerable — the question in any
        // resuscitation study. Totals are still emitted, as a derived summary.
        if (ev.type !== "drug" && ev.type !== "agent_start"
          && ev.type !== "infusion_start" && ev.type !== "fluid_start") continue
        const meta = (ev.metadataJson ?? {}) as Record<string, unknown>
        const doseSource = ev.type === "infusion_start" ? ev.rate
          : ev.type === "fluid_start" ? ev.volume
            : meta.dose
        // Not `parseFloat(...) || null`: a genuinely zero rate or volume --
        // an infusion charted as running at 0 mL/h while paused -- must
        // survive as 0, not collapse into the same row as no dose recorded.
        const dose = numOrNull(doseSource)
        drugs.push({
          drug_exposure_id:           nextId(),
          person_id:                  personId,
          // The concept resolved when the event was written. It used to be
          // hardcoded 0, so every drug given during a case exported as unmapped
          // while its ATC sat in the row unused — and the same drug listed
          // preoperatively exported mapped.
          drug_concept_id:            ev.standardConceptId ?? 0,
          drug_exposure_start_date:   isoDate(ev.timestamp),
          drug_exposure_end_date:     endFor(ev, index),
          // 32818, EHR administration record: this was charted as given, not
          // reported by the patient and not merely prescribed. Same type as
          // premedication below, for the same reason -- both are witnessed
          // administrations -- and different from the preop medication list
          // above, which is self-report. INTRAOP: in the source value is what
          // actually tells this row apart from a premedication of the same
          // drug, since drug_type_concept_id alone cannot: OMOP's Type Concept
          // vocabulary encodes provenance, not clinical phase, and has nothing
          // for "premedication" versus "intraoperative".
          drug_type_concept_id:       32818,
          // The ATC moves into the source value, where source codes belong. It
          // was previously the only place the code appeared, so dropping it
          // from the concept id column without doing this would lose the one
          // identifier an unmapped intraoperative drug still had.
          drug_source_value:          ev.atcCode
            ? `INTRAOP:ATC:${ev.atcCode} - ${(meta.name as string | undefined) ?? ev.label ?? ""}`.trimEnd()
            : `INTRAOP:${(meta.name as string | undefined) ?? ev.label ?? "unknown"}`,
          drug_source_concept_id:     null,
          dose_value:                 dose,
          dose_unit_source_value:     ev.unit ?? (meta.unit as string | undefined) ?? (ev.type === "agent_start" ? "%" : null),
          route_source_value:         ev.drugRoute ?? (meta.drugRoute as string | undefined) ?? (ev.type === "agent_start" ? "INHALATIONAL" : "IV"),
          visit_occurrence_id:        visitId,
        })
        if (ev.type === "drug") {
          const concentration = ev.concentration
            ?? formatCanonicalConcentration(ev.concentrationValue, ev.concentrationUnit)
          // Third element is the numeric form where the text is a rendering of
          // a number: "0.5%" is a concentration of 0.5, and a preset version is
          // an ordinal a researcher may want to compare rather than match.
          const auditObservations: Array<[string, string | null | undefined, number | null]> = [
            ["LOSPOR:DRUG_CONCENTRATION", concentration, ev.concentrationValue ?? null],
            ["LOSPOR:DRUG_FORMULATION", ev.formulation, null],
            ["LOSPOR:DOSE_CALCULATION_BASIS", ev.calculationBasis, null],
            ["LOSPOR:DOSE_CALCULATION_METHOD", ev.calculationMethod, null],
            ["LOSPOR:CLINICAL_RULE_KEY", ev.clinicalRuleKey, null],
            ["LOSPOR:CLINICAL_RULE_VERSION", ev.clinicalRuleVersion, null],
            ["LOSPOR:CLINICAL_PRESET_ID", ev.clinicalPresetId, null],
            [
              "LOSPOR:CLINICAL_PRESET_VERSION",
              ev.clinicalPresetVersion == null ? null : String(ev.clinicalPresetVersion),
              ev.clinicalPresetVersion ?? null,
            ],
            ["LOSPOR:CLINICAL_PRESET_SCOPE", ev.clinicalPresetScope, null],
            [
              "LOSPOR:CLINICAL_RULE_SOURCE_IDS",
              Array.isArray(ev.clinicalRuleSourceIds)
                ? ev.clinicalRuleSourceIds.filter(value => typeof value === "string").join("|")
                : null,
              null,
            ],
          ]
          for (const [source, value, numericValue] of auditObservations) {
            if (!value) continue
            sourceObservation(source, value, isoDate(ev.timestamp), numericValue)
          }
          if (ev.calculationWeightKg != null) {
            measurements.push({
              measurement_id: nextId(),
              person_id: personId,
              measurement_concept_id: 0,
              measurement_date: isoDate(ev.timestamp),
              measurement_datetime: ev.timestamp.toISOString(),
              measurement_type_concept_id: 32817,
              value_as_number: ev.calculationWeightKg,
              value_as_concept_id: null,
              // 9529, UCUM kg. The measurement concept stays 0 -- no vocabulary
              // codes "the weight a dose was calculated from" as distinct from
              // body weight itself -- but the value is still genuinely
              // kilograms, so the unit is coded regardless.
              unit_concept_id: 9529,
              unit_source_value: "kg",
              measurement_source_value: "LOSPOR:DOSE_CALCULATION_WEIGHT_KG",
              // Vitals carry no source text and no laboratory reference range.
              value_source_value:        null,
              range_low:                 null,
              range_high:                null,
              visit_occurrence_id: visitId,
            })
          }
        }
      }

      for (const prem of c.intraop.premedicationRows ?? []) {
        trackMapping(prem.mappingStatus)
        const dose = numOrNull(prem.dose)
        drugs.push({
          drug_exposure_id: nextId(), person_id: personId,
          drug_concept_id: prem.standardConceptId ?? 0,
          drug_exposure_start_date: startDate,
          // A single administration, not an interval: no end to record.
          drug_exposure_end_date: null,
          // 32818, EHR administration record -- see the intraop site for why
          // this is the same type as an intraop dose and not the preop
          // medication list, and why PREMED: below, not this column, is what
          // actually separates the two.
          drug_type_concept_id: 32818,
          // Same correction as the other two drug sites: the ATC is source text
          // and belongs in the source value, not in a numeric concept column.
          // PREMED: is what tells this row apart from an intraop dose of the
          // same drug once both share drug_type_concept_id 32818 -- without it,
          // midazolam given at induction and midazolam given as premedication
          // would be the same string.
          drug_source_value: prem.atcCode
            ? `PREMED:ATC:${prem.atcCode} - ${prem.nameRaw}`
            : `PREMED:${prem.nameRaw}`,
          drug_source_concept_id: null,
          dose_value: dose,
          dose_unit_source_value: doseUnitOf(prem.dose),
          route_source_value: prem.route,
          visit_occurrence_id: visitId,
        })
        sourceObservation("LOSPOR:PREMEDICATION_PHASE", prem.phase, startDate)
        // 4169397, Premedication for anesthetic procedure. A fact alongside
        // the drug row above, not a replacement for it: the drug row says
        // which substance and dose, this says the clinical act of
        // premedicating happened. One per row, matching the one-event-one-row
        // pattern used everywhere else in this file.
        procedures.push({
          procedure_occurrence_id:   nextId(),
          person_id:                 personId,
          procedure_concept_id:      4169397,
          procedure_date:            startDate,
          procedure_type_concept_id: 32817,
          modifier_concept_id:       0,
          modifier_source_value:     null,
          procedure_source_value:    "LOSPOR:PREMEDICATION",
          visit_occurrence_id:       visitId,
        })
      }

      // Same duplication problem as the anaesthesia technique above: "Art
      // line in"/"CVC in"/"PICC" name no specific site, so they can only
      // refine a vascular-access row unambiguously when exactly one line of
      // that family exists on the case. Two arterial lines (e.g. one
      // pre-existing, one placed) leave it unclear which the marker timed.
      const ARTERIAL_LINE_CONCEPTS = new Set([4311043, 4051187, 4052409, 4052408, 4049830, 4050420])
      const CENTRAL_VENOUS_CONCEPTS = new Set([4052413, 4051188, 4052414, 4052415, 4050424, 4052416])
      const vascularAccessLines = c.intraop.vascularAccessRows ?? []
      const vascularAccessConcept = (line: typeof vascularAccessLines[number]) =>
        line.standardConceptId ?? vascularAccessConceptFor(line.site)
      const arterialLines = vascularAccessLines.filter(l => ARTERIAL_LINE_CONCEPTS.has(vascularAccessConcept(l)))
      const centralVenousLines = vascularAccessLines.filter(l => CENTRAL_VENOUS_CONCEPTS.has(vascularAccessConcept(l)))
      const piccLines = vascularAccessLines.filter(l => vascularAccessConcept(l) === 4322380)
      const artLineInTs = arterialLines.length === 1 ? clinicalEventTimestamp("Art line in") : undefined
      const cvcInTs = centralVenousLines.length === 1 ? clinicalEventTimestamp("CVC in") : undefined
      const piccInTs = piccLines.length === 1 ? clinicalEventTimestamp("PICC") : undefined

      for (const line of vascularAccessLines) {
        const resolvedConcept = vascularAccessConcept(line)
        const preciseTs = ARTERIAL_LINE_CONCEPTS.has(resolvedConcept) ? artLineInTs
          : CENTRAL_VENOUS_CONCEPTS.has(resolvedConcept) ? cvcInTs
          : resolvedConcept === 4322380 ? piccInTs
          : undefined
        procedures.push({
          procedure_occurrence_id: nextId(), person_id: personId,
          // The site is coded from the catalogue when relational-sync has not
          // already resolved one, so a radial arterial line and an internal
          // jugular central line stop sharing concept 0. The exact site the
          // anaesthetist chose stays in the source value either way.
          procedure_concept_id: resolvedConcept,
          procedure_date: preciseTs ? isoDate(preciseTs) : startDate,
          procedure_datetime: preciseTs ? preciseTs.toISOString() : null,
          procedure_type_concept_id: 32817,
          modifier_concept_id:       0,
          modifier_source_value:     null,
          procedure_source_value: `VASCULAR_ACCESS:${line.siteLabel ?? line.site ?? "unknown"}${line.size ? ` ${line.size}${line.sizeUnit ?? ""}` : ""}`,
          visit_occurrence_id: visitId,
        })
        // Depth, lumen count and whether the line was already there were
        // selected and discarded. The last one matters most: a pre-existing
        // line was not placed during this case, so counting it as a procedure
        // performed here overstates what the anaesthetist did.
        const lineKey = line.siteLabel ?? line.site ?? "unknown"
        if (line.depthCm) sourceObservation("LOSPOR:VASCULAR_ACCESS_DEPTH_CM", `${lineKey}=${line.depthCm}`, startDate, Number(line.depthCm))
        if (line.lumens) sourceObservation("LOSPOR:VASCULAR_ACCESS_LUMENS", `${lineKey}=${line.lumens}`, startDate, Number(line.lumens))
        sourceObservation("LOSPOR:VASCULAR_ACCESS_PREEXISTING", `${lineKey}=${line.preexisting}`, startDate)
      }

      // PA catheter and IO access have no counterpart elsewhere in the
      // export -- vascularAccessRows has no site for either -- so these are
      // new rows, not refinements, with the marker's own timestamp since it
      // is the only source of one.
      const paCathTs = clinicalEventTimestamp("PA cath")
      if (paCathTs) {
        procedures.push({
          procedure_occurrence_id:   nextId(),
          person_id:                 personId,
          // 4052529, Pulmonary artery catheter insertion via jugular vein --
          // SNOMED has no route-unqualified concept, and jugular is coded by
          // product decision as the default route; the source value carries
          // no route detail either, since the event does not capture one.
          procedure_concept_id:      4052529,
          procedure_date:            isoDate(paCathTs),
          procedure_datetime:        paCathTs.toISOString(),
          procedure_type_concept_id: 32817,
          modifier_concept_id:       0,
          modifier_source_value:     null,
          procedure_source_value:    "INTRAOP_EVENT:PA cath",
          visit_occurrence_id:       visitId,
        })
      }
      const ioAccessTs = clinicalEventTimestamp("IO access")
      if (ioAccessTs) {
        procedures.push({
          procedure_occurrence_id:   nextId(),
          person_id:                 personId,
          procedure_concept_id:      4257889, // Insertion of needle for intraosseous infusion
          procedure_date:            isoDate(ioAccessTs),
          procedure_datetime:        ioAccessTs.toISOString(),
          procedure_type_concept_id: 32817,
          modifier_concept_id:       0,
          modifier_source_value:     null,
          procedure_source_value:    "INTRAOP_EVENT:IO access",
          visit_occurrence_id:       visitId,
        })
      }

      // Fluid totals as observations. Millilitres given: a quantity, and one
      // that is routinely summed across a cohort.
      sourceObservation("LOSPOR:CRYSTALLOIDS_ML", c.intraop.crystalloidsMl, endDate)
      sourceObservation("LOSPOR:COLLOIDS_ML", c.intraop.colloidsMl, endDate)
      sourceObservation("LOSPOR:BLOOD_PRODUCTS_ML", c.intraop.bloodMl, endDate)

      // The volume stays uncoded above -- PROCEDURE_OCCURRENCE has no volume
      // or unit column to put it in, in this export or in the CDM's own
      // spec, where the nearest field is an integer "quantity" meant for a
      // repeat count, not a continuous measurement. What can be coded here is
      // the separate fact that an administration of this kind happened, so
      // these are additional rows, not a replacement for the mL figures.
      //
      // Only when the volume is a recorded positive number: a colloidsMl of 0
      // is a documented "none given", and a row asserting the procedure
      // occurred would misstate that.
      const administrationOccurred = (v: unknown) => (numOrNull(v) ?? 0) > 0
      const emitAdministration = (source: string, conceptId: number) => {
        procedures.push({
          procedure_occurrence_id:   nextId(),
          person_id:                 personId,
          procedure_concept_id:      conceptId,
          procedure_date:            endDate,
          procedure_type_concept_id: 32817,
          modifier_concept_id:       0,
          modifier_source_value:     null,
          procedure_source_value:    source,
          visit_occurrence_id:       visitId,
        })
      }
      // Not crystalloids: SNOMED names the specific fluid -- Hartmann's,
      // dextrose, saline -- and this field is a pooled total that does not
      // say which. Every candidate concept would assert a fluid that may not
      // be the one actually given, and 4030886 (Intravenous infusion) is true
      // of every drug, colloid and blood product too, so it would say nothing
      // that distinguishes a crystalloid from anything else. No concept here
      // is more honest than a wrong or a meaningless one.
      if (administrationOccurred(c.intraop.colloidsMl)) {
        emitAdministration("LOSPOR:COLLOID_ADMINISTRATION", 44790654)
      }
      if (administrationOccurred(c.intraop.bloodMl)) {
        emitAdministration("LOSPOR:BLOOD_PRODUCT_TRANSFUSION", 4024656)
      }
      // 3014315, unqualified. Not the 1-hour or 8-hour variants, which assert
      // a collection window this records nothing about -- what is stored is a
      // case total.
      sourceMeasurement("LOSPOR:URINE_OUTPUT_ML", c.intraop.urineMl, 3014315, 8587, "mL", endDate)
      sourceObservation("LOSPOR:BLOOD_LOSS_ML", c.intraop.bloodLossMl, endDate)
    }

    for (const sel of c.selections ?? []) {
      // A selected option from the institution's option library — a label, not
      // a quantity, even when the label happens to read as a number.
      observations.push({
        observation_id: nextId(), person_id: personId,
        // The option library's reviewed concept when there is one. CaseSelection
        // has carried standardConceptId all along; the export simply never
        // asked for it, so a mapped monitoring line still claimed to map to
        // nothing.
        observation_concept_id: sel.standardConceptId ?? 0,
        observation_date: startDate,
        observation_type_concept_id: 32817,
        value_as_number: null,
        value_as_string: sel.value,
        value_as_concept_id: 0,
        observation_source_value: `LOSPOR:${sel.section.toUpperCase()}_${sel.category.toUpperCase()}`,
        visit_occurrence_id: visitId,
      })
    }

    for (const comp of c.complications ?? []) {
      trackMapping(comp.mappingStatus)
      const compDate = isoDate(comp.timestamp) ?? (comp.section === "postop" ? endDate : startDate)
      if (comp.standardConceptId != null && COMPLICATION_OBSERVATION_DOMAIN_CONCEPTS.has(comp.standardConceptId)) {
        // A handful of curated complications -- "Difficult intubation",
        // "Failed intubation of trachea" -- are themselves Observation-domain
        // SNOMED findings (an assessment, not a diagnosed condition), unlike
        // the rest of the catalogue. They stay in OBSERVATION with their real
        // concept, rather than defaulting into CONDITION_OCCURRENCE with the
        // rest and putting an Observation-domain concept in the wrong table.
        observations.push({
          observation_id: nextId(), person_id: personId,
          observation_concept_id: comp.standardConceptId,
          observation_date: compDate,
          observation_type_concept_id: 32817,
          value_as_number: null,
          value_as_string: comp.note ? `${comp.label}; ${comp.note}` : comp.label,
          value_as_concept_id: 0,
          observation_source_value: sourceValue("LOSPOR_COMPLICATION", comp.sourceVocabulary, comp.sourceCode, comp.label),
          visit_occurrence_id: visitId,
        })
      } else if (comp.standardConceptId != null && COMPLICATION_PROCEDURE_DOMAIN_CONCEPTS.has(comp.standardConceptId)) {
        // "Endobronchial intubation" is a Procedure-domain SNOMED concept --
        // something that was done to the patient, not a disorder found or an
        // assessment made -- so it reaches PROCEDURE_OCCURRENCE rather than
        // either of the other two tables.
        procedures.push({
          procedure_occurrence_id:   nextId(),
          person_id:                 personId,
          procedure_concept_id:      comp.standardConceptId,
          procedure_date:            compDate,
          procedure_type_concept_id: 32817,
          modifier_concept_id:       0,
          modifier_source_value:     null,
          procedure_source_value:    sourceValue("LOSPOR_COMPLICATION", comp.sourceVocabulary, comp.sourceCode, comp.label),
          visit_occurrence_id:       visitId,
        })
        if (comp.note) {
          sourceObservation(`LOSPOR:${comp.section.toUpperCase()}_COMPLICATION_NOTE`, `${comp.label}; ${comp.note}`, compDate)
        }
      } else if (comp.standardConceptId != null) {
        // Every other curated complication concept is a Condition-domain
        // SNOMED finding -- the catalogue names arrhythmias, infarctions,
        // injuries, things that happened to the patient, not observations
        // about them -- so a resolved complication belongs in
        // CONDITION_OCCURRENCE, the same table a comorbidity or a diagnosis
        // reaches. Unmapped complications (the majority, until the catalogue
        // is fully curated) keep the old shape below rather than exporting a
        // 0 into a table that implies a real diagnosis was made.
        conditions.push({
          condition_occurrence_id:    nextId(),
          person_id:                  personId,
          condition_concept_id:       comp.standardConceptId,
          condition_start_date:       compDate,
          condition_type_concept_id:  32817,
          condition_source_value:     sourceValue("LOSPOR_COMPLICATION", comp.sourceVocabulary, comp.sourceCode, comp.label),
          visit_occurrence_id:        visitId,
        })
        // The free-text note is not a fact CONDITION_OCCURRENCE has anywhere
        // to put -- it stays a companion observation, keyed to the same
        // complication, so it still passes through the redaction pipeline the
        // way every other free-text field in this export does.
        if (comp.note) {
          sourceObservation(`LOSPOR:${comp.section.toUpperCase()}_COMPLICATION_NOTE`, `${comp.label}; ${comp.note}`, compDate)
        }
      } else {
        observations.push({
          observation_id: nextId(), person_id: personId,
          observation_concept_id: 0,
          observation_date: compDate,
          observation_type_concept_id: 32817,
          value_as_number: null,
          value_as_string: comp.note ? `${comp.label}; ${comp.note}` : comp.label,
          value_as_concept_id: 0,
          observation_source_value: `LOSPOR:${comp.section.toUpperCase()}_COMPLICATION`,
          visit_occurrence_id: visitId,
        })
      }
    }

    // ── Postop -> OBSERVATION ─────────────────────────────────────────────────
    if (c.postop) {
      const postDate = endDate ?? isoDate(c.createdAt)
      // Same qualifier as preop: recovery observations that could not be taken
      // are a finding about the patient, not an omission. One flag covers both
      // halves of a blood pressure.
      const postopVitals: [keyof typeof VITAL_CONCEPTS, number | null | undefined, boolean][] = [
        ["systolic", c.postop.recoveryBpSystolic, Boolean(c.postop.recoveryBpUnobtainable)],
        ["diastolic", c.postop.recoveryBpDiastolic, Boolean(c.postop.recoveryBpUnobtainable)],
        ["heartRate", c.postop.recoveryHeartRate, Boolean(c.postop.recoveryHeartRateUnobtainable)],
        ["spO2", c.postop.recoverySpO2, Boolean(c.postop.recoverySpO2Unobtainable)],
        ["temp", c.postop.temperatureCelsius, Boolean(c.postop.recoveryTemperatureUnobtainable)],
      ]
      for (const [key, val, unobtainable] of postopVitals) {
        if (val == null && !unobtainable) continue
        const cfg = VITAL_CONCEPTS[key]
        measurements.push({ measurement_id: nextId(), person_id: personId, measurement_concept_id: cfg.concept_id, measurement_date: postDate, measurement_datetime: postDate, measurement_type_concept_id: 32817, value_as_number: val ?? null, value_as_concept_id: val == null ? UNOBTAINABLE_CONCEPT_ID : null, unit_concept_id: cfg.unitConceptId, unit_source_value: cfg.unit, measurement_source_value: `POSTOP_LOINC:${cfg.loinc}`, value_source_value: null, range_low: null, range_high: null, visit_occurrence_id: visitId })
      }
      // Aldrete subscores and their total: 0-2 each, 0-10 summed. A discharge
      // threshold is a numeric comparison, so these have to be numbers.
      //
      // The five subscores have no concept in this vocabulary -- only the
      // total is a scored entity in SNOMED, the same shape as RCRI's
      // criteria. They stay observations at concept 0.
      sourceObservation("LOSPOR:ALDRETE_ACTIVITY", c.postop.aldreteActivity, postDate)
      sourceObservation("LOSPOR:ALDRETE_RESPIRATION", c.postop.aldreteRespiration, postDate)
      sourceObservation("LOSPOR:ALDRETE_CIRCULATION", c.postop.aldreteCirculation, postDate)
      sourceObservation("LOSPOR:ALDRETE_CONSCIOUSNESS", c.postop.aldreteConsciousness, postDate)
      sourceObservation("LOSPOR:ALDRETE_SPO2", c.postop.aldreteSpO2, postDate)
      // The total, unlike its subscores, is a scored entity in SNOMED, so it
      // moves to measurement.value_as_number the same way RCRI and STOP-BANG
      // did -- an OMOP measurement, not a LOSPOR-only observation.
      if (c.postop.aldreteTotal != null) {
        measurements.push({
          measurement_id:              nextId(),
          person_id:                   personId,
          measurement_concept_id:      40488911,
          measurement_date:            postDate,
          measurement_datetime:        postDate,
          measurement_type_concept_id: 32817,
          value_as_number:             c.postop.aldreteTotal,
          value_as_concept_id:         null,
          unit_concept_id:             0,
          unit_source_value:           null,
          measurement_source_value:    "LOSPOR:ALDRETE_TOTAL",
          value_source_value:          String(c.postop.aldreteTotal),
          range_low:                   null,
          range_high:                  null,
          visit_occurrence_id:         visitId,
        })
      }
      if (c.postop.pediatricPainScore != null && c.postop.pediatricPainScale) {
        const scale = c.postop.pediatricPainScale
        const scoreSource = `LOSPOR:PEDIATRIC_PAIN_${scale}_0_10`
        if (scale === "FLACC") {
          // FLACC is a Measurement-domain concept in SNOMED, unlike FPS-R
          // below, which the vocabulary itself puts in Observation -- that
          // split is the vocabulary's own choice, not an inconsistency here.
          measurements.push({
            measurement_id:              nextId(),
            person_id:                   personId,
            measurement_concept_id:      3037051,
            measurement_date:            postDate,
            measurement_datetime:        postDate,
            measurement_type_concept_id: 32817,
            value_as_number:             c.postop.pediatricPainScore,
            value_as_concept_id:         null,
            unit_concept_id:             0,
            unit_source_value:           null,
            measurement_source_value:    scoreSource,
            value_source_value:          String(c.postop.pediatricPainScore),
            range_low:                   null,
            range_high:                  null,
            visit_occurrence_id:         visitId,
          })
        } else if (scale === "FPS_R") {
          sourceObservation(scoreSource, c.postop.pediatricPainScore, postDate, c.postop.pediatricPainScore, 40760807)
        } else {
          // NRS has no reviewed concept, the same as the adult NRS branch
          // below -- stays a source-only observation at concept 0.
          // The same 0-10 verbal numeric rating as the adult NRS below, so the
          // same concept. It was left uncoded when 43055141 was not in the
          // vocabulary bundle this product shipped with.
          sourceMeasurement(scoreSource, c.postop.pediatricPainScore, 43055141, 0, null, postDate)
        }
      } else if (c.postop.painScoreNRS != null) {
        // 43055141, Pain severity - 0-10 verbal numeric rating [Score].
        //
        // This was 3020891 once -- the concept for body temperature, copied
        // from the vital map -- which would have made a pain score of 3 show
        // up in any OHDSI temperature query. Correcting that left it at 0,
        // with a comment saying LOSPOR had no reviewed mapping for the NRS
        // concept. That was true of the vocabulary bundle shipping at the
        // time and is no longer: the concept is standard, Measurement-domain,
        // and exactly this scale, so the row moves to measurement.
        sourceMeasurement("LOINC:72514-3", c.postop.painScoreNRS, 43055141, 0, null, postDate)
      }
      sourceObservation("LOSPOR:PAED_SCORE", c.postop.paedScore, postDate)
      // A condition that occurred, not an observation about one -- the same
      // domain routing already used for comorbidities and diagnoses.
      // Recorded only when present, and as a fact rather than a count.
      if (c.postop.ponv) {
        conditions.push({
          condition_occurrence_id:    nextId(),
          person_id:                  personId,
          condition_concept_id:       4032472,
          condition_start_date:       postDate ?? startDate,
          condition_type_concept_id:  32817,
          condition_source_value:     "LOSPOR:PONV",
          visit_occurrence_id:        visitId,
        })
      }
      // Each value is its own fact rather than an answer to one reusable
      // question -- "Discharge to ward" and "Admission to intensive care
      // unit" are different SNOMED concepts with no shared question concept
      // between them, unlike a yes/no field. PACU has no concept in this
      // vocabulary: the nearest match, "Post Anesthesia Care Unit" (45880582),
      // is a Meas Value/Answer concept, not a fact that belongs in
      // observation_concept_id, and nothing else names remaining in recovery
      // as an event.
      const dispositionConcept = c.postop.disposition === "WARD" ? 4142136
        : c.postop.disposition === "ICU" ? 4138933
        : 0
      sourceObservation("LOSPOR:DISPOSITION", c.postop.disposition, postDate, null, dispositionConcept)
    }
  }

  const tableCounts = {
    person: persons.length,
    observation_period: observationPeriods.length,
    visit_occurrence: visits.length,
    condition_occurrence: conditions.length,
    drug_exposure: drugs.length,
    measurement: measurements.length,
    procedure_occurrence: procedures.length,
    device_exposure: devices_.length,
    observation: observations.length,
  }
  const qualityWarnings = buildQualityWarnings(cases, mappingSummary)

  const caseDates = cases.map(row => row.createdAt.getTime())
  const dateRange = cases.length
    ? { from: new Date(Math.min(...caseDates)).toISOString(), to: new Date(Math.max(...caseDates)).toISOString() }
    : null

  return {
    metadata: {
      export_id:               ctx?.exportId ?? crypto.randomUUID(),
      omop_cdm_version:        "5.4",
      generated_at:            ctx?.generatedAt ?? new Date().toISOString(),
      generated_by_user_id:    ctx?.userId ?? "unknown",
      generated_by_role:       ctx?.userRole ?? "unknown",
      source:                  "LOSPOR",
      source_version:          "3.8.0",
      schema_version:          "3.6.0",
      concept_map_version:     "local-bilingual-map-v2",
      data_dictionary_version: DICTIONARY_VERSION,
      case_status_filter:      ctx?.statusFilter ?? [],
      date_range:              dateRange,
      matching_case_count:     ctx?.matchingCaseCount ?? cases.length,
      exported_case_count:     cases.length,
      complete:                ctx?.complete ?? true,
      included_case_count:     cases.length,
      excluded_case_count:     ctx?.excludedCaseCount ?? 0,
      app_git_commit:          ctx?.gitCommit ?? "untracked",
      forced_override:         ctx?.forcedOverride ?? false,
      case_count:              cases.length,
      mapping_summary:         mappingSummary,
      table_counts:            tableCounts,
      quality_warnings:        qualityWarnings,
      data_quality_status:     deriveQualityStatus(qualityWarnings),
      deidentification: {
        mode:                              "pseudonymised",
        person_id_strategy:               "deterministic 52-bit identifier derived from SHA-256 of the internal case ID (optionally salted) — not reversible without the source database. One person per case: no patient identifier is stored, so the same patient across two operations appears as two persons.",
        direct_patient_identifiers_stored: false,
        event_timestamp_precision:        "exact_datetime",
        residual_linkage_risks: [
          "exact intraoperative event timestamps (not rounded or shifted)",
          "case-level institution/care-site linkage",
          "rare procedure, complication, and timeline combinations",
        ],
      },
      note: "Numeric observations carry their value in observation.value_as_number and, unchanged, as text in observation.value_as_string; genuinely textual observations populate value_as_string only. OMOP concept IDs are emitted only where LOSPOR has a confident local mapping. Source vocabulary, source code, English/Bulgarian labels, and source-only rows are preserved for research traceability. Pediatric mode, precise age at procedure, rule provenance, pediatric risk scores, and recovery scores are preserved as source observations with concept_id 0 until reviewed mappings exist. person_id is a deterministic pseudonym derived from SHA-256 of the internal case ID — no patient names, national IDs, or direct identifiers are stored. PERSON carries an approximate year_of_birth derived from age at operation (month and day are unknown, not defaulted); race and ethnicity are not collected and are emitted as concept 0. OBSERVATION_PERIOD spans the operation only. Intraoperative event timestamps are preserved at exact DateTime precision for clinical sequence analysis — see residual_linkage_risks.",
    },
    care_site:             [...careSites.values()],
    person:                persons,
    observation_period:    observationPeriods,
    visit_occurrence:      visits,
    condition_occurrence:  conditions,
    drug_exposure:         drugs,
    measurement:           measurements,
    procedure_occurrence:  procedures,
    device_exposure:       devices_,
    observation:           observations,
  }
}
