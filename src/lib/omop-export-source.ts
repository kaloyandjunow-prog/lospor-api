import type { Prisma } from "@/generated/prisma/client"
import { deepRedactPII, redactText } from "@/lib/pii-check"

type ExportRow = Prisma.CaseGetPayload<{ select: typeof CASE_SELECT }>

// Redacts the free-text fields this export actually selects — scalar String
// fields a clinician can type into directly, plus the freeform keyEvents
// JSON blob and each CaseEvent's label/value. Coded fields (comorbidities,
// diagnosesJson, proceduresJson, labRows) are left untouched: they're
// structured vocabulary entries, and blanket-redacting them would corrupt
// legitimate two-word diagnosis/institution labels via the name-pattern check.
//
// That reasoning was right but was applied only to the JSON columns. The
// scalar columns below hold the *same* clinical vocabulary, and they were
// going through the full name-pattern check — so a register received
// "[REDACTED]" where a diagnosis belonged ("Acute Cholecystitis" and
// "Sodium Chloride" both read as names). They now use nameHeuristic: false,
// which keeps every structural check — EGN, long numbers, dates, email — and
// drops only the two-capitalised-words guess that cannot tell a disease from
// a patient. Genuine prose keeps the guess on.
export function redactExportRow(c: ExportRow) {
  const coded = { nameHeuristic: false } as const
  return {
    ...c,
    preop: c.preop ? {
      ...c.preop,
      // Coded clinical vocabulary.
      diagnosis: c.preop.diagnosis ? redactText(c.preop.diagnosis, coded) : c.preop.diagnosis,
      plannedProcedure: c.preop.plannedProcedure ? redactText(c.preop.plannedProcedure, coded) : c.preop.plannedProcedure,
      allergyDetails: c.preop.allergyDetails ? redactText(c.preop.allergyDetails, coded) : c.preop.allergyDetails,
      currentMedications: c.preop.currentMedications ? redactText(c.preop.currentMedications, coded) : c.preop.currentMedications,
      // Free prose written by a clinician, so it goes through the same
      // redaction as every other note before it can leave.
      familyAnesthesiaDetails: c.preop.familyAnesthesiaDetails ? redactText(c.preop.familyAnesthesiaDetails) : c.preop.familyAnesthesiaDetails,
      difficultAirwayNotes: c.preop.difficultAirwayNotes ? redactText(c.preop.difficultAirwayNotes) : c.preop.difficultAirwayNotes,
      medications: c.preop.medications.map(row => ({
        ...row,
        nameRaw: row.nameRaw ? redactText(row.nameRaw, coded) : row.nameRaw,
      })),
    } : c.preop,
    events: (c.events ?? []).map(e => ({
      ...e,
      // label is the coded event/drug name; value is whatever was recorded
      // against it, so only the label is exempt.
      label: e.label ? redactText(e.label, coded) : e.label,
      value: e.value ? redactText(e.value) : e.value,
    })),
    complications: (c.complications ?? []).map(comp => ({
      ...comp,
      note: comp.note ? redactText(comp.note) : comp.note,
    })),
    intraop: c.intraop ? {
      ...c.intraop,
      complications: c.intraop.complications ? redactText(c.intraop.complications) : c.intraop.complications,
      premedicationEvening: c.intraop.premedicationEvening ? redactText(c.intraop.premedicationEvening) : c.intraop.premedicationEvening,
      premedicationMorning: c.intraop.premedicationMorning ? redactText(c.intraop.premedicationMorning) : c.intraop.premedicationMorning,
      keyEvents: deepRedactPII(c.intraop.keyEvents),
      premedicationRows: c.intraop.premedicationRows.map(row => ({
        ...row,
        nameRaw: row.nameRaw ? redactText(row.nameRaw, coded) : row.nameRaw,
      })),
    } : c.intraop,
  }
}

export const CASE_SELECT = {
  id: true, researchId: true, createdAt: true, status: true, clinicalMode: true, clinicalRulesVersion: true,
  institutionId: true,
  user: { select: { institution: { select: { name: true } } } },
  fieldStatuses: {
    select: { section: true, fieldKey: true, presence: true },
  },
  selections: {
    select: { section: true, category: true, value: true, ordinal: true, sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true, },
    orderBy: [{ section: "asc" }, { category: "asc" }, { ordinal: "asc" }],
  },
  complications: {
    select: { section: true, label: true, note: true, timestamp: true, source: true, ordinal: true, sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true, },
    orderBy: [{ section: "asc" }, { ordinal: "asc" }],
  },
  events: {
    where: { status: "active" },
    select: {
      type: true,
      timestamp: true,
      label: true,
      value: true,
      unit: true,
      systolic: true,
      diastolic: true,
      heartRate: true,
      spO2: true,
      etco2: true,
      temp: true,
      bgl: true,
      bglLoincCode: true,
      bglUnitCanon: true,
      fgfLitersPerMin: true,
      carrierGas: true,
      fio2Percent: true,
      fiAirPercent: true,
      fiN2OPercent: true,
      atcCode: true,
      drugId: true,
      inn: true,
      drugRoute: true,
      standardConceptId: true,
      mappingStatus: true,
      rate: true,
      concentration: true,
      concentrationValue: true,
      concentrationUnit: true,
      formulation: true,
      calculationBasis: true,
      calculationWeightKg: true,
      calculationMethod: true,
      clinicalRuleKey: true,
      clinicalRuleVersion: true,
      clinicalRuleSourceIds: true,
      clinicalPresetId: true,
      clinicalPresetVersion: true,
      clinicalPresetScope: true,
      infId: true,
      fluidId: true,
      volume: true,
      fluidCategory: true,
      agentPercent: true,
      clinicalEventCode: true,
      metadataJson: true,
    },
  },
  preop: {
    select: {
      ageYears: true, ageValue: true, ageUnit: true, ageApproxDays: true,
      sex: true, heightCm: true, weightKg: true, bodySurfaceAreaM2: true,
      bpSystolic: true, bpDiastolic: true, heartRate: true, spO2: true,
      temperature: true, respiratoryRate: true,
      // The unobtainable flags travel with the values they qualify. Without
      // them the export cannot tell a measurement nobody attempted from one
      // that was attempted and could not be obtained — and the second is a
      // finding about the patient, not a gap in the paperwork.
      bpUnobtainable: true, heartRateUnobtainable: true, spO2Unobtainable: true,
      temperatureUnobtainable: true, respiratoryRateUnobtainable: true,
      airwayUnobtainable: true,
      diagnosis: true, diagnosesJson: true, plannedProcedure: true, proceduresJson: true,
      comorbidities: true, asaScore: true, emergencySurgery: true, highRiskSurgery: true,
      allergies: true, allergyDetails: true, smoking: true, substanceAbuse: true,
      // Clinical detail that was read into the mapper's row types but never
      // written to any table, so it left the appliance nowhere.
      bmi: true, bloodType: true, rhFactor: true, gutaScore: true,
      latexAllergy: true, familyAnesthesiaProblems: true, familyAnesthesiaDetails: true,
      dentalProsthetics: true, looseTeeth: true, heartArrhythmia: true,
      // The airway examination, as distinct from the difficult-airway history.
      mouthOpeningCm: true, thyromental: true, neckMobility: true, upperLipBiteTest: true,
      retrognathia: true, prominentIncisors: true, facialHair: true,
      difficultAirwayNotes: true, anticipatedDifficultAirway: true,
      // The two anaesthesia-history questions that are about this patient
      // rather than their family.
      malignantHyperthermiaHistory: true, unexplainedAnaesthesiaComplications: true,
      currentMedications: true, rcriScore: true, apfelScore: true, stopBangScore: true,
      povocScore: true, povocRiskPercent: true, coldsScore: true, pediatricFasting: true,
      difficultAirwayHistory: true, mallampati: true, labResults: true,
      labRows: {
        select: {
          test: true, valueNum: true, value: true, unitCanon: true, loincCode: true, abnormalFlag: true,
          // A result the lab reported as text, and the range it was judged
          // against. Without the range, "high" is an assertion the export
          // cannot support; without the text, a qualitative result vanished.
          referenceLow: true, referenceHigh: true,
          standardConceptId: true, mappingStatus: true,
        },
      },
      diagnoses: {
        select: {
          code: true, label: true, labelEn: true, labelBg: true,
          sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true, ordinal: true,
        },
        orderBy: { ordinal: "asc" },
      },
      procedureRows: {
        select: {
          code: true, group: true, domain: true, description: true,
          sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true, ordinal: true,
        },
        orderBy: { ordinal: "asc" },
      },
      comorbidityRows: {
        select: {
          label: true, labelEn: true, labelBg: true, code: true, icd10Code: true,
          sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true, ordinal: true,
        },
        orderBy: { ordinal: "asc" },
      },
      medications: {
        select: {
          kind: true, nameRaw: true, inn: true, atcCode: true, dose: true, route: true,
          sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true, ordinal: true,
        },
        orderBy: [{ kind: "asc" }, { ordinal: "asc" }],
      },
    },
  },
  intraop: {
    select: {
      startedAt: true, endedAt: true, timezone: true,
      startTime: true, endTime: true, durationMinutes: true, monthYear: true,
      techniques: true, keyEvents: true, airwayDevice: true,
      // Airway management detail. None of this used to leave the appliance, so
      // an export could say a tube was placed but never which one, what size,
      // whether it was cuffed, or how hard the laryngoscopy was -- the part a
      // difficult-airway study is actually about.
      airwayDevices: true, cormackLehane: true, airwayTools: true, fob: true,
      lmaSize: true,
      oralTubeSize: true, oralCuffed: true, nasalTubeSize: true, nasalCuffed: true,
      dltType: true, dltSide: true, dltSize: true, endobronchialSize: true,
      // Legacy single-device columns, still the only size on older rows.
      tubeSize: true, cuffed: true,
      ventilationModes: true, ippv: true, jetVentilation: true, peepCmH2O: true,
      crystalloidsMl: true, colloidsMl: true, bloodMl: true, urineMl: true, bloodLossMl: true,
      complications: true, premedicationEvening: true, premedicationMorning: true,
      vascularAccessRows: {
        select: { site: true, siteLabel: true, size: true, sizeUnit: true, depthCm: true, lumens: true, preexisting: true, ordinal: true, sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true, },
        orderBy: { ordinal: "asc" },
      },
      premedicationRows: {
        select: {
          phase: true, nameRaw: true, inn: true, atcCode: true, dose: true, route: true,
          sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true, ordinal: true,
        },
        orderBy: [{ phase: "asc" }, { ordinal: "asc" }],
      },
    },
  },
  postop: {
    select: {
      aldreteActivity: true, aldreteRespiration: true, aldreteCirculation: true, aldreteConsciousness: true, aldreteSpO2: true,
      aldreteTotal: true, painScoreNRS: true, pediatricPainScale: true,
      pediatricPainScore: true, paedScore: true, ponv: true, disposition: true,
      recoveryBpSystolic: true, recoveryBpDiastolic: true, recoveryHeartRate: true, recoverySpO2: true, temperatureCelsius: true,
      recoveryBpUnobtainable: true, recoveryHeartRateUnobtainable: true,
      recoverySpO2Unobtainable: true, recoveryTemperatureUnobtainable: true,
      complications: true,
    },
  },
  finalizations: {
    orderBy: { sequence: "desc" as const },
    take: 1,
    select: { id: true },
  },
  updatedAt:   true,
  finalizedAt: true,
} satisfies Prisma.CaseSelect
