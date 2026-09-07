import type { CaseMapperCtx } from "../case-context"
import type { CaseRow } from "../types"
import {
  AIRWAY_ACTS, AIRWAY_ACT_CONCEPTS, AIRWAY_DEVICE_CONCEPTS, AIRWAY_TOOL_CONCEPTS,
  TECHNIQUE_CONCEPTS, TECHNIQUE_PARENT, VENTILATION_MODE_CONCEPTS, VITAL_CONCEPTS,
  YES_CONCEPT_ID, NO_CONCEPT_ID, techniqueConceptFor, vascularAccessConceptFor,
  doseUnitOf,
} from "../concepts"
import { isoDate, numOrNull } from "../date-helpers"
import { nextId } from "../ids"
import { formatCanonicalConcentration } from "@/lib/case-event-schema"

/**
 * Everything witnessed during the case: airway management, ventilation,
 * techniques, drug/fluid administrations, vascular access and intraoperative
 * labs.
 */
export function mapIntraopToOmop(
  ctx: CaseMapperCtx,
  c: CaseRow,
  ia: NonNullable<CaseRow["intraop"]>,
): void {
  // 1176109, Anesthesia duration, which is an Observation-domain concept,
  // so unlike the other numbers in this batch it stays where it already is.
  ctx.sourceObservation("LOSPOR:ANAESTHESIA_DURATION_MIN", ia.durationMinutes, ctx.startDate,
    ia.durationMinutes, 1176109)

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
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []

  // airwayDevice is the older single column; airwayDevices is the current
  // list. Both may be populated, so they are merged and de-duplicated
  // rather than one being preferred and the other silently dropped.
  const devices = [...new Set([...(ia.airwayDevice ? [ia.airwayDevice] : []), ...strList(ia.airwayDevices)])]
  // The device itself, alongside the act of placing it. Both are true and
  // they answer different questions -- see OmopDevice.
  for (const device of devices) {
    ctx.sourceObservation("LOSPOR:AIRWAY_DEVICE", device)
    ctx.devices.push({
      device_exposure_id:         nextId(),
      person_id:                  ctx.personId,
      device_concept_id:          AIRWAY_DEVICE_CONCEPTS[device] ?? 0,
      device_exposure_start_date: ctx.startDate,
      device_exposure_end_date:   ctx.endDate,
      device_type_concept_id:     32817,
      device_source_value:        "AIRWAY_DEVICE:" + device,
      visit_occurrence_id:        ctx.visitId,
    })
  }

  // The laryngoscopy grade is what an airway-prediction study compares the
  // preoperative assessment against, so it carries its standard concept
  // rather than a LOSPOR-only code. There is no unobtainable flag on the
  // intraoperative record: an absent grade means no direct laryngoscopy.
  ctx.emitAirwayGrade("cormackLehane", ia.cormackLehane, ctx.startDate, false)
  for (const tool of strList(ia.airwayTools)) {
    ctx.sourceObservation("LOSPOR:AIRWAY_TOOL", tool)
    ctx.devices.push({
      device_exposure_id:         nextId(),
      person_id:                  ctx.personId,
      device_concept_id:          AIRWAY_TOOL_CONCEPTS[tool] ?? 0,
      device_exposure_start_date: ctx.startDate,
      device_exposure_end_date:   ctx.endDate,
      device_type_concept_id:     32817,
      device_source_value:        "AIRWAY_TOOL:" + tool,
      visit_occurrence_id:        ctx.visitId,
    })
  }
  // 4337615, Orotracheal fiberoptic intubation. This field sits in the
  // airway-tools section, so it means fibreoptic intubation rather than
  // 604177 (Flexible bronchoscopy), which is a diagnostic procedure. The
  // oral route is asserted rather than recorded -- the form has a single
  // flag and does not say which route the scope took -- so this is a
  // product decision of the same kind as the sciatic block approach, and
  // 4337617 is the nasal counterpart if the form ever distinguishes them.
  ctx.sourceObservation("LOSPOR:FIBREOPTIC_BRONCHOSCOPY", ia.fob, ctx.startDate, null, 4337615,
    ia.fob ? YES_CONCEPT_ID : NO_CONCEPT_ID)

  // Sizes are recorded per device. The legacy tubeSize/cuffed pair is the
  // only size older rows carry, so it is exported under its own code
  // rather than being guessed onto one of the per-device ones.
  ctx.sourceObservation("LOSPOR:LMA_SIZE", ia.lmaSize)
  // 21491186, Endotracheal tube Diameter -- a Measurement-domain LOINC
  // concept, so the sizes move out of observation. The same concept covers
  // every tube whose diameter is recorded in millimetres; which tube it
  // was stays in measurement_source_value.
  ctx.sourceMeasurement("LOSPOR:ORAL_TUBE_SIZE", numOrNull(ia.oralTubeSize), 21491186, 8588, "mm")
  ctx.cuffedObservation("LOSPOR:ORAL_TUBE_CUFFED", ia.oralCuffed)
  ctx.sourceMeasurement("LOSPOR:NASAL_TUBE_SIZE", numOrNull(ia.nasalTubeSize), 21491186, 8588, "mm")
  ctx.cuffedObservation("LOSPOR:NASAL_TUBE_CUFFED", ia.nasalCuffed)
  ctx.sourceObservation("LOSPOR:DLT_TYPE", ia.dltType)
  ctx.sourceObservation("LOSPOR:DLT_SIDE", ia.dltSide)
  ctx.sourceObservation("LOSPOR:DLT_SIZE", ia.dltSize)
  ctx.sourceObservation("LOSPOR:ENDOBRONCHIAL_TUBE_SIZE", ia.endobronchialSize)
  ctx.sourceMeasurement("LOSPOR:TUBE_SIZE_LEGACY", numOrNull(ia.tubeSize), 21491186, 8588, "mm")
  ctx.cuffedObservation("LOSPOR:TUBE_CUFFED_LEGACY", ia.cuffed)

  // ── Ventilation ──────────────────────────────────────────────────────
  // 3004921, Ventilation mode Ventilator -- a Measurement-domain LOINC
  // concept, so this belongs in MEASUREMENT, not OBSERVATION where it
  // sat before: putting a Measurement-domain concept in
  // observation_concept_id is exactly the CDM violation "domain governs
  // table" exists to catch, the same as BSA/PEEP/urine output earlier.
  // The mode itself now carries a real answer concept too, where the
  // vocabulary has one -- see VENTILATION_MODE_CONCEPTS.
  for (const mode of strList(ia.ventilationModes)) {
    ctx.measurements.push({
      measurement_id:              nextId(),
      person_id:                   ctx.personId,
      measurement_concept_id:      3004921,
      measurement_date:            ctx.startDate,
      measurement_datetime:        ctx.startDate,
      measurement_type_concept_id: 32817,
      value_as_number:             null,
      value_as_concept_id:         VENTILATION_MODE_CONCEPTS[mode] ?? 0,
      unit_concept_id:             0,
      unit_source_value:           null,
      measurement_source_value:    "LOSPOR:VENTILATION_MODE",
      value_source_value:          mode,
      range_low:                   null,
      range_high:                  null,
      visit_occurrence_id:         ctx.visitId,
    })
  }
  // Unqualified in both cases: the fields are plain flags, and the
  // narrower concepts assert a route or a modality neither records.
  ctx.sourceObservation("LOSPOR:IPPV", ia.ippv, ctx.startDate, null, 607086,
    ia.ippv ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  ctx.sourceObservation("LOSPOR:JET_VENTILATION", ia.jetVentilation, ctx.startDate, null, 4168475,
    ia.jetVentilation ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  // 3022875, the ventilator *setting*, which is what an anaesthetist
  // charts -- not 3016226, the measured airway pressure.
  ctx.sourceMeasurement("LOSPOR:PEEP_CMH2O", ia.peepCmH2O, 3022875, 44777590, "cm[H2O]")

  // ── Why there is no airway device of this team's own ──────────────────
  // Both are emitted only when asserted. False is the ordinary case, where
  // the airway rows above already say what was done, and a row claiming
  // "did not arrive intubated" on every case would be noise.
  //
  // Arrived with a tube somebody else placed. The decomposition is the
  // vocabulary's own: SNOMED "Endotracheal tube present" (4168966) is
  // non-standard and Athena maps it to 1340204 (History of event) with
  // "Maps to value" 4013354 (Insertion of endotracheal tube). So the
  // export states exactly that pair -- a history of tracheal intubation --
  // which is the honest claim: the intubation is real and predates this
  // team, and no procedure_occurrence row is created for an act they did
  // not perform.
  if (ia.presentsIntubated) {
    ctx.sourceObservation("LOSPOR:PRESENTS_INTUBATED", true, ctx.startDate, null, 1340204, 4013354)
  }
  // No airway intervention at all -- a regional or sedation case where the
  // patient kept their own airway. CDM has no way to record a procedure
  // that did not happen (a procedure_occurrence row means it did), so the
  // negative is an observation: 4303568 (Airway management) answered No.
  // That is the same question-and-answer shape IPPV and jet ventilation
  // already use above.
  if (ia.airwayNotApplicable) {
    ctx.sourceObservation("LOSPOR:AIRWAY_NOT_APPLICABLE", true, ctx.startDate, null, 4303568, NO_CONCEPT_ID)
  }

  // A technique/act's placement is sometimes also logged as its own
  // intraop timeline marker -- the same procedure, witnessed twice.
  // Rather than emit the marker as a second procedure_occurrence row
  // (double-counting the act for any cohort built on this concept), its
  // timestamp refines the act's own row instead, wherever exactly one
  // matching row exists to refine.
  const clinicalEventTimestamp = (label: string): Date | undefined =>
    (c.events ?? []).find(e => e.type === "clinical_event" && e.label === label)?.timestamp

  // ── Airway acts -> PROCEDURE_OCCURRENCE ──────────────────────────────
  //
  // Derived from the devices actually recorded, so a case documents the
  // intubation it performed and not the one it might have. Devices with no
  // corresponding act -- a face mask, a nasal cannula -- produce no
  // procedure, which is correct: nothing was placed.
  const airwayActs = devices.map(d => AIRWAY_ACTS[d]).filter((a): a is string => Boolean(a))
  const intubatedTs = airwayActs.filter(a => a === "TRACHEAL_INTUBATION_ORAL" || a === "TRACHEAL_INTUBATION_NASAL").length === 1
    ? clinicalEventTimestamp("Intubated") : undefined
  const lmaInTs = airwayActs.filter(a => a === "SUPRAGLOTTIC_AIRWAY_PLACEMENT").length === 1
    ? clinicalEventTimestamp("LMA in") : undefined
  const dltPlacedTs = airwayActs.filter(a => a === "DOUBLE_LUMEN_TUBE_PLACEMENT").length === 1
    ? clinicalEventTimestamp("DLT placed") : undefined
  for (const device of devices) {
    const act = AIRWAY_ACTS[device]
    if (!act) continue
    const preciseTs = (act === "TRACHEAL_INTUBATION_ORAL" || act === "TRACHEAL_INTUBATION_NASAL") ? intubatedTs
      : act === "SUPRAGLOTTIC_AIRWAY_PLACEMENT" ? lmaInTs
      : act === "DOUBLE_LUMEN_TUBE_PLACEMENT" ? dltPlacedTs
      : undefined
    ctx.procedures.push({
      procedure_occurrence_id:   nextId(),
      person_id:                 ctx.personId,
      procedure_concept_id:      AIRWAY_ACT_CONCEPTS[act] ?? 0,
      procedure_date:            preciseTs ? isoDate(preciseTs) : ctx.startDate,
      procedure_datetime:        preciseTs ? preciseTs.toISOString() : null,
      procedure_type_concept_id: 32817,
      modifier_concept_id:       0,
      modifier_source_value:     null,
      procedure_source_value:    `AIRWAY_MANAGEMENT:${act}`,
      visit_occurrence_id:       ctx.visitId,
    })
  }

  // Induction, Mask ventilation, Extubation and an airway-exchange-
  // catheter exchange have no existing row anywhere else in the export
  // to refine -- induction and mask ventilation are never coded facts
  // today, and extubation/exchange are not the reverse of any row above
  // (removing a tube is a distinct procedure from placing one, the same
  // reasoning as Spinal removed). All four are new rows, timestamped
  // from the marker itself.
  const emitMilestoneProcedure = (label: string, conceptId: number) => {
    const ts = clinicalEventTimestamp(label)
    if (!ts) return
    ctx.procedures.push({
      procedure_occurrence_id:   nextId(),
      person_id:                 ctx.personId,
      procedure_concept_id:      conceptId,
      procedure_date:            isoDate(ts),
      procedure_datetime:        ts.toISOString(),
      procedure_type_concept_id: 32817,
      modifier_concept_id:       0,
      modifier_source_value:     null,
      procedure_source_value:    `INTRAOP_EVENT:${label}`,
      visit_occurrence_id:       ctx.visitId,
    })
  }
  const AIRWAY_MILESTONE_CONCEPTS: Record<string, number> = {
    "Induction":       4082850, // Induction of general anesthesia
    "Mask vent":       37157165, // Positive pressure ventilation via bag and mask
    "Extubated":       4148972, // Extubation of trachea
    "Airway exchange": 4216776, // Airway exchange catheter procedure
  }
  for (const [label, conceptId] of Object.entries(AIRWAY_MILESTONE_CONCEPTS)) emitMilestoneProcedure(label, conceptId)

  // Surgical milestones. "Positioned", "Procedure started" and
  // "Procedure ended" have no concept -- SNOMED has nothing for
  // "positioning complete" or a generic operation start/end distinct
  // from Incision/Closure -- and stay unmapped.
  const SURGICAL_MILESTONE_CONCEPTS: Record<string, number> = {
    "Incision":       4214428, // Incision of skin
    "Tourniquet on":  4049036, // Application of tourniquet
    "Tourniquet off": 4084008, // Tourniquet cuff deflation
  }
  for (const [label, conceptId] of Object.entries(SURGICAL_MILESTONE_CONCEPTS)) emitMilestoneProcedure(label, conceptId)

  // A technique's placement is sometimes also logged as its own
  // intraop timeline marker ("Spinal in", "Epidural in") -- the same
  // procedure, witnessed twice. Rather than emit that marker as a
  // second procedure_occurrence row (double-counting the block for any
  // cohort built on this concept), its timestamp refines the technique
  // row's own date/time instead: the technique list says a spinal was
  // done, the timeline says exactly when. clinicalEventTimestamp is
  // defined above, by the airway acts.

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

  const techs: string[] = Array.isArray(ia.techniques) ? ia.techniques as string[] : []
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
    ctx.procedures.push({
      procedure_occurrence_id:    nextId(),
      person_id:                 ctx.personId,
      // Coded at the level the vocabulary supports; the node the
      // anaesthetist actually chose stays in the source value.
      procedure_concept_id:      techConceptId,
      procedure_date:            preciseTs ? isoDate(preciseTs) : ctx.startDate,
      procedure_datetime:        preciseTs ? preciseTs.toISOString() : null,
      procedure_type_concept_id: 32817,
      modifier_concept_id:       0,
      modifier_source_value:     null,
      procedure_source_value:    `ANAESTHESIA_TECHNIQUE:${tech}`,
      visit_occurrence_id:       ctx.visitId,
    })
  }

  // Removing a neuraxial catheter is a distinct procedure from placing
  // one, not a second sighting of the same fact -- so unlike Spinal in/
  // Epidural in/Block done above, this is its own new row rather than a
  // refinement.
  const spinalRemovedTs = clinicalEventTimestamp("Spinal removed")
  if (spinalRemovedTs) {
    ctx.procedures.push({
      procedure_occurrence_id:    nextId(),
      person_id:                  ctx.personId,
      procedure_concept_id:       37165151, // Removal of intrathecal catheter
      procedure_date:             isoDate(spinalRemovedTs),
      procedure_datetime:         spinalRemovedTs.toISOString(),
      procedure_type_concept_id:  32817,
      modifier_concept_id:        0,
      modifier_source_value:      null,
      procedure_source_value:     "INTRAOP_EVENT:Spinal removed",
      visit_occurrence_id:        ctx.visitId,
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
        ["bis", ev.bis, null],
        ["tofRatio", ev.tofRatio, null],
        ["cvp", ev.cvp, null],
      ]
      for (const [key, val, loincOverride] of eventVitals) {
        if (val == null) continue
        const cfg = VITAL_CONCEPTS[key]
        ctx.measurements.push({
          measurement_id:            nextId(),
          person_id:                 ctx.personId,
          measurement_concept_id:    cfg.concept_id,
          measurement_date:          isoDate(ev.timestamp),
          measurement_datetime:      ev.timestamp.toISOString(),
          measurement_type_concept_id: 32817,
          value_as_number:           val,
          value_as_concept_id: null,
          unit_concept_id:           cfg.unitConceptId,
          unit_source_value:         cfg.unit,
          measurement_source_value:  `${cfg.system ?? "LOINC"}:${loincOverride ?? cfg.code}`,
          // Vitals carry no source text and no laboratory reference range.
          value_source_value:        null,
          range_low:                 null,
          range_high:                null,
          visit_occurrence_id:       ctx.visitId,
        })
      }
    }
    if (ev.type === "agent_start" && ev.agentPercent != null) {
      // 4354275, Inspired anesthetic agent concentration -- the dial
      // setting, which is what this records. Not 4107998 (End tidal), a
      // different measured quantity, and not the unqualified 4353943.
      // Measurement domain, so it moves out of observation.
      ctx.measurements.push({
        measurement_id:              nextId(),
        person_id:                   ctx.personId,
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
        visit_occurrence_id:         ctx.visitId,
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
        ctx.measurements.push({
          measurement_id: nextId(), person_id: ctx.personId,
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
          visit_occurrence_id: ctx.visitId,
        })
      }
      ctx.sourceObservation("LOSPOR:FGF_L_PER_MIN", ev.fgfLitersPerMin, isoDate(ev.timestamp),
        ev.fgfLitersPerMin, 4108006)
      ctx.sourceObservation("LOSPOR:FIN2O_PERCENT", ev.fiN2OPercent, isoDate(ev.timestamp),
        ev.fiN2OPercent, 4354273)
      ctx.sourceObservation("LOSPOR:CARRIER_GAS", ev.carrierGas, isoDate(ev.timestamp))
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
    ctx.drugs.push({
      drug_exposure_id:           nextId(),
      person_id:                  ctx.personId,
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
      visit_occurrence_id:        ctx.visitId,
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
        ctx.sourceObservation(source, value, isoDate(ev.timestamp), numericValue)
      }
      if (ev.calculationWeightKg != null) {
        ctx.measurements.push({
          measurement_id: nextId(),
          person_id: ctx.personId,
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
          visit_occurrence_id: ctx.visitId,
        })
      }
    }
  }

  for (const prem of ia.premedicationRows ?? []) {
    ctx.trackMapping(prem.mappingStatus)
    const dose = numOrNull(prem.dose)
    ctx.drugs.push({
      drug_exposure_id: nextId(), person_id: ctx.personId,
      drug_concept_id: prem.standardConceptId ?? 0,
      drug_exposure_start_date: ctx.startDate,
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
      visit_occurrence_id: ctx.visitId,
    })
    ctx.sourceObservation("LOSPOR:PREMEDICATION_PHASE", prem.phase, ctx.startDate)
    // 4169397, Premedication for anesthetic procedure. A fact alongside
    // the drug row above, not a replacement for it: the drug row says
    // which substance and dose, this says the clinical act of
    // premedicating happened. One per row, matching the one-event-one-row
    // pattern used everywhere else in this file.
    ctx.procedures.push({
      procedure_occurrence_id:   nextId(),
      person_id:                 ctx.personId,
      procedure_concept_id:      4169397,
      procedure_date:            ctx.startDate,
      procedure_type_concept_id: 32817,
      modifier_concept_id:       0,
      modifier_source_value:     null,
      procedure_source_value:    "LOSPOR:PREMEDICATION",
      visit_occurrence_id:       ctx.visitId,
    })
  }

  // Same duplication problem as the anaesthesia technique above: "Art
  // line in"/"CVC in"/"PICC" name no specific site, so they can only
  // refine a vascular-access row unambiguously when exactly one line of
  // that family exists on the case. Two arterial lines (e.g. one
  // pre-existing, one placed) leave it unclear which the marker timed.
  const ARTERIAL_LINE_CONCEPTS = new Set([4311043, 4051187, 4052409, 4052408, 4049830, 4050420])
  const CENTRAL_VENOUS_CONCEPTS = new Set([4052413, 4051188, 4052414, 4052415, 4050424, 4052416])
  const vascularAccessLines = ia.vascularAccessRows ?? []
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
    const lineSource = `VASCULAR_ACCESS:${line.siteLabel ?? line.site ?? "unknown"}${line.size ? ` ${line.size}${line.sizeUnit ?? ""}` : ""}`
    if (line.preexisting) {
      // The line was already in the patient. Emitting a
      // procedure_occurrence for it would credit this team with an
      // insertion somebody else performed -- the exact fault the comment
      // here used to describe while the code went on doing it anyway.
      //
      // Stated instead as a history, the same decomposition
      // presentsIntubated uses: 1340204 (History of event) answered with
      // the line's own concept. So "history of: insertion of arterial
      // catheter", which is true and does not overstate the work.
      ctx.sourceObservation(lineSource, true, ctx.startDate, null, 1340204, resolvedConcept)
    } else {
      ctx.procedures.push({
        procedure_occurrence_id: nextId(), person_id: ctx.personId,
        // The site is coded from the catalogue when relational-sync has not
        // already resolved one, so a radial arterial line and an internal
        // jugular central line stop sharing concept 0. The exact site the
        // anaesthetist chose stays in the source value either way.
        procedure_concept_id: resolvedConcept,
        procedure_date: preciseTs ? isoDate(preciseTs) : ctx.startDate,
        procedure_datetime: preciseTs ? preciseTs.toISOString() : null,
        procedure_type_concept_id: 32817,
        modifier_concept_id:       0,
        modifier_source_value:     null,
        procedure_source_value: lineSource,
        visit_occurrence_id: ctx.visitId,
      })
    }
    // Depth and lumen count were selected and discarded. The pre-existing
    // flag is kept alongside the coded history above: it is the per-line
    // answer including its negative, which the history row cannot state
    // because it only exists when the answer is yes.
    const lineKey = line.siteLabel ?? line.site ?? "unknown"
    if (line.depthCm) ctx.sourceObservation("LOSPOR:VASCULAR_ACCESS_DEPTH_CM", `${lineKey}=${line.depthCm}`, ctx.startDate, Number(line.depthCm))
    if (line.lumens) ctx.sourceObservation("LOSPOR:VASCULAR_ACCESS_LUMENS", `${lineKey}=${line.lumens}`, ctx.startDate, Number(line.lumens))
    ctx.sourceObservation("LOSPOR:VASCULAR_ACCESS_PREEXISTING", `${lineKey}=${line.preexisting}`, ctx.startDate)
  }

  // PA catheter and IO access have no counterpart elsewhere in the
  // export -- vascularAccessRows has no site for either -- so these are
  // new rows, not refinements, with the marker's own timestamp since it
  // is the only source of one.
  const paCathTs = clinicalEventTimestamp("PA cath")
  if (paCathTs) {
    ctx.procedures.push({
      procedure_occurrence_id:   nextId(),
      person_id:                 ctx.personId,
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
      visit_occurrence_id:       ctx.visitId,
    })
  }
  const ioAccessTs = clinicalEventTimestamp("IO access")
  if (ioAccessTs) {
    ctx.procedures.push({
      procedure_occurrence_id:   nextId(),
      person_id:                 ctx.personId,
      procedure_concept_id:      4257889, // Insertion of needle for intraosseous infusion
      procedure_date:            isoDate(ioAccessTs),
      procedure_datetime:        ioAccessTs.toISOString(),
      procedure_type_concept_id: 32817,
      modifier_concept_id:       0,
      modifier_source_value:     null,
      procedure_source_value:    "INTRAOP_EVENT:IO access",
      visit_occurrence_id:       ctx.visitId,
    })
  }

  // Fluid totals as observations. Millilitres given: a quantity, and one
  // that is routinely summed across a cohort.
  ctx.sourceObservation("LOSPOR:CRYSTALLOIDS_ML", ia.crystalloidsMl, ctx.endDate)
  ctx.sourceObservation("LOSPOR:COLLOIDS_ML", ia.colloidsMl, ctx.endDate)
  ctx.sourceObservation("LOSPOR:BLOOD_PRODUCTS_ML", ia.bloodMl, ctx.endDate)

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
    ctx.procedures.push({
      procedure_occurrence_id:   nextId(),
      person_id:                 ctx.personId,
      procedure_concept_id:      conceptId,
      procedure_date:            ctx.endDate,
      procedure_type_concept_id: 32817,
      modifier_concept_id:       0,
      modifier_source_value:     null,
      procedure_source_value:    source,
      visit_occurrence_id:       ctx.visitId,
    })
  }
  // Not crystalloids: SNOMED names the specific fluid -- Hartmann's,
  // dextrose, saline -- and this field is a pooled total that does not
  // say which. Every candidate concept would assert a fluid that may not
  // be the one actually given, and 4030886 (Intravenous infusion) is true
  // of every drug, colloid and blood product too, so it would say nothing
  // that distinguishes a crystalloid from anything else. No concept here
  // is more honest than a wrong or a meaningless one.
  if (administrationOccurred(ia.colloidsMl)) {
    emitAdministration("LOSPOR:COLLOID_ADMINISTRATION", 44790654)
  }
  if (administrationOccurred(ia.bloodMl)) {
    emitAdministration("LOSPOR:BLOOD_PRODUCT_TRANSFUSION", 4024656)
  }
  // 3014315, unqualified. Not the 1-hour or 8-hour variants, which assert
  // a collection window this records nothing about -- what is stored is a
  // case total.
  ctx.sourceMeasurement("LOSPOR:URINE_OUTPUT_ML", ia.urineMl, 3014315, 8587, "mL", ctx.endDate)
  ctx.sourceObservation("LOSPOR:BLOOD_LOSS_ML", ia.bloodLossMl, ctx.endDate)


  // ── Lab draws taken during the case -> MEASUREMENT ────────────────────
  // The same emission path preoperative labs use. Each row carries its own
  // `takenAt`, so a gas at induction and one after transfusion land on the
  // timeline where they happened; the case start is only the fallback for
  // a draw whose time was never recorded.
  ctx.emitLabRows(ia.labRows ?? [], ctx.startDate)
}
