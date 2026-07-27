import type { Prisma } from "@/generated/prisma/client"
import { deepRedactPII, redactText } from "@/lib/pii-check"

type ExportRow = Prisma.CaseGetPayload<{ select: typeof CASE_SELECT }>

// Redacts the free-text fields this export actually selects ??? scalar String
// fields a clinician can type into directly, plus the freeform keyEvents
// JSON blob and each CaseEvent's label/value. Coded fields (comorbidities,
// diagnosesJson, proceduresJson, labRows) are left untouched: they're
// structured vocabulary entries, and blanket-redacting them would corrupt
// legitimate two-word diagnosis/institution labels via the name-pattern check.
export function redactExportRow(c: ExportRow) {
  return {
    ...c,
    preop: c.preop ? {
      ...c.preop,
      diagnosis: c.preop.diagnosis ? redactText(c.preop.diagnosis) : c.preop.diagnosis,
      plannedProcedure: c.preop.plannedProcedure ? redactText(c.preop.plannedProcedure) : c.preop.plannedProcedure,
      allergyDetails: c.preop.allergyDetails ? redactText(c.preop.allergyDetails) : c.preop.allergyDetails,
      currentMedications: c.preop.currentMedications ? redactText(c.preop.currentMedications) : c.preop.currentMedications,
      medications: c.preop.medications.map(row => ({
        ...row,
        nameRaw: row.nameRaw ? redactText(row.nameRaw) : row.nameRaw,
      })),
    } : c.preop,
    events: (c.events ?? []).map(e => ({
      ...e,
      label: e.label ? redactText(e.label) : e.label,
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
        nameRaw: row.nameRaw ? redactText(row.nameRaw) : row.nameRaw,
      })),
    } : c.intraop,
  }
}

export const CASE_SELECT = {
  id: true, caseCode: true, createdAt: true, status: true,
  institutionId: true,
  user: { select: { institution: { select: { name: true } } } },
  fieldStatuses: {
    select: { section: true, fieldKey: true, presence: true },
  },
  selections: {
    select: { section: true, category: true, value: true, ordinal: true },
    orderBy: [{ section: "asc" }, { category: "asc" }, { ordinal: "asc" }],
  },
  complications: {
    select: { section: true, label: true, note: true, timestamp: true, source: true, ordinal: true },
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
      rate: true,
      concentration: true,
      volume: true,
      fluidCategory: true,
      agentPercent: true,
      clinicalEventCode: true,
      metadataJson: true,
    },
  },
  preop: {
    select: {
      ageYears: true, sex: true, heightCm: true, weightKg: true,
      bpSystolic: true, bpDiastolic: true, heartRate: true, spO2: true,
      temperature: true, respiratoryRate: true,
      diagnosis: true, diagnosesJson: true, plannedProcedure: true, proceduresJson: true,
      comorbidities: true, asaScore: true, emergencySurgery: true, highRiskSurgery: true,
      allergies: true, allergyDetails: true, smoking: true, substanceAbuse: true,
      currentMedications: true, rcriScore: true, apfelScore: true, stopBangScore: true,
      difficultAirwayHistory: true, mallampati: true, labResults: true,
      labRows: {
        select: {
          test: true, valueNum: true, value: true, unitCanon: true, loincCode: true, abnormalFlag: true,
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
      crystalloidsMl: true, colloidsMl: true, bloodMl: true, urineMl: true,
      complications: true, premedicationEvening: true, premedicationMorning: true,
      vascularAccessRows: {
        select: { site: true, siteLabel: true, size: true, sizeUnit: true, depthCm: true, lumens: true, preexisting: true, ordinal: true },
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
      aldreteTotal: true, painScoreNRS: true, ponv: true, disposition: true,
      recoveryBpSystolic: true, recoveryBpDiastolic: true, recoveryHeartRate: true, recoverySpO2: true, temperatureCelsius: true,
      complications: true,
    },
  },
  snapshot:    { select: { id: true } },
  updatedAt:   true,
  finalizedAt: true,
} satisfies Prisma.CaseSelect
