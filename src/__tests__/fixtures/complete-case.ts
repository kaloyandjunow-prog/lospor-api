/**
 * A case with every section populated, used by the OMOP tests and by the data
 * dictionary consistency check.
 *
 * It is deliberately maximal: the dictionary test asserts that every concept a
 * fully populated case emits has a documented entry, and that assertion is only
 * as good as the fixture is complete. A field left out here is a column the
 * check cannot notice going undocumented.
 */
export function completeCaseFixture(overrides: Record<string, unknown> = {}) {
  const createdAt = new Date("2026-06-01T07:30:00Z")
  const startTime = new Date("2026-06-01T08:00:00Z")
  const endTime = new Date("2026-06-01T09:00:00Z")
  return {
    id: "case-omop-1",
    researchId: "10000000-0000-4000-8000-000000000001",
    createdAt,
    status: "COMPLETE",
    institutionId: "inst-1",
    user: { institution: { name: "Fallback Hospital" } },
    fieldStatuses: [{ section: "preop", fieldKey: "ageYears", presence: "PRESENT" }],
    finalizations: [{ id: "finalization-1" }],
    updatedAt: new Date("2026-06-01T09:01:00Z"),
    finalizedAt: new Date("2026-06-01T09:01:00Z"),
    selections: [{ section: "intraop", category: "monitoring", value: "ecg", ordinal: 0, sourceVocabulary: "LOSPOR_OPTION", sourceCode: "MON_ECG", standardConceptId: 4187078, mappingStatus: "MAPPED" }],
    complications: [{ section: "postop", label: "PONV", note: "treated", timestamp: endTime, source: "relational-sync", ordinal: 0, sourceVocabulary: "LOSPOR_COMPLICATION", sourceCode: "PONV", standardConceptId: 4166237, mappingStatus: "MAPPED" }],
    events: [
      {
        type: "vital",
        timestamp: new Date("2026-06-01T08:15:00Z"),
        label: null,
        value: null,
        unit: null,
        systolic: 118,
        diastolic: 70,
        heartRate: 76,
        spO2: 99,
        etco2: 36,
        temp: 36.5,
        bgl: 5.6,
        bglLoincCode: "2345-7",
        bglUnitCanon: "mmol/L",
        atcCode: null,
        drugId: null,
        drugRoute: null,
        metadataJson: {},
      },
      {
        type: "drug",
        timestamp: new Date("2026-06-01T08:20:00Z"),
        label: "Fentanyl",
        value: null,
        unit: "mcg",
        bgl: null,
        bglLoincCode: null,
        bglUnitCanon: null,
        atcCode: "N01AH01",
        drugId: "drug-1",
        standardConceptId: 1154029,
        mappingStatus: "MAPPED",
        drugRoute: "IV",
        metadataJson: { dose: "50", name: "Fentanyl" },
      },
      {
        type: "infusion_start",
        timestamp: new Date("2026-06-01T08:25:00Z"),
        label: "Propofol TCI",
        value: null, unit: "mg/kg/h", infId: "inf-1",
        atcCode: "N01AX10", drugId: null, standardConceptId: 19020053, mappingStatus: "MAPPED",
        rate: "6", metadataJson: { name: "Propofol" },
      },
      {
        type: "infusion_stop",
        timestamp: new Date("2026-06-01T09:10:00Z"),
        label: "Propofol TCI", value: null, unit: null, infId: "inf-1",
        metadataJson: {},
      },
      {
        type: "agent_start",
        timestamp: new Date("2026-06-01T08:35:00Z"),
        label: "Sevoflurane", value: null, unit: "%",
        agentPercent: 2, metadataJson: { name: "Sevoflurane" },
        // ATC N01AB08, resolved the way a real event now is: at write time, by
        // resolveDrugExposureConcepts. Left without one for a while after that
        // resolver shipped, which is exactly the state a case charted before
        // this concept existed in the vocabulary would still be in.
        atcCode: "N01AB08", standardConceptId: 19039298, mappingStatus: "MAPPED",
      },
      {
        type: "agent_stop",
        timestamp: new Date("2026-06-01T09:05:00Z"),
        label: "Sevoflurane", value: null, unit: null, metadataJson: {},
      },
      {
        type: "fluid_start",
        timestamp: new Date("2026-06-01T08:40:00Z"),
        label: "Ringer lactate", value: null, unit: "mL", fluidId: "fl-1",
        volume: 500, fluidCategory: "CRYSTALLOID", metadataJson: { name: "Ringer lactate" },
        // B05BB01 is a real, correctly-resolved ATC code with no OMOP standard
        // concept behind it -- SOURCE_ONLY, verified against the live
        // ConceptMap, not a gap in this fixture. Left uncoded on purpose: this
        // is the honest state, not something to "fix".
        atcCode: "B05BB01", standardConceptId: null, mappingStatus: "SOURCE_ONLY",
      },
      {
        type: "fluid_end",
        timestamp: new Date("2026-06-01T08:55:00Z"),
        label: "Ringer lactate", value: null, unit: null, fluidId: "fl-1",
        metadataJson: {},
      },
      {
        type: "gas_change",
        timestamp: new Date("2026-06-01T08:30:00Z"),
        label: null,
        value: null,
        unit: null,
        fgfLitersPerMin: 2,
        carrierGas: "AIR/O2",
        fio2Percent: 50,
        fiAirPercent: 50,
        fiN2OPercent: 0,
        bgl: null,
        bglLoincCode: null,
        bglUnitCanon: null,
        atcCode: null,
        drugId: null,
        drugRoute: null,
        metadataJson: {},
      },
    ],
    preop: {
      ageYears: 14,
      sex: "MALE",
      heightCm: 165,
      weightKg: 60,
      bpSystolic: 126,
      bpDiastolic: 74,
      heartRate: 82,
      spO2: 99,
      temperature: 36.7,
      respiratoryRate: 14,
      diagnosis: "fallback diagnosis",
      diagnosesJson: [],
      plannedProcedure: "fallback procedure",
      proceduresJson: [],
      comorbidities: [],
      asaScore: "I",
      emergencySurgery: false,
      highRiskSurgery: false,
      allergies: true,
      allergyDetails: "Penicillin, shellfish",
      // A recorded "no" and an unasked question, side by side, so the export's
      // handling of the two can be told apart.
      smoking: false,
      substanceAbuse: false,
      latexAllergy: false,
      familyAnesthesiaProblems: true,
      familyAnesthesiaDetails: "Maternal uncle, prolonged apnoea after suxamethonium",
      dentalProsthetics: false,
      looseTeeth: null,
      heartArrhythmia: false,
      currentMedications: null,
      rcriScore: 0,
      apfelScore: 1,
      stopBangScore: 1,
      bmi: 24.2,
      bloodType: "A",
      rhFactor: "POSITIVE",
      gutaScore: 2,
      difficultAirwayHistory: true,
      difficultAirwayNotes: "Grade III view at previous laparotomy",
      mallampati: "I",
      // The airway examination, as distinct from the history above.
      mouthOpeningCm: 4.5,
      thyromental: 6.5,
      neckMobility: "FULL",
      upperLipBiteTest: "CLASS_I",
      retrognathia: false,
      prominentIncisors: true,
      facialHair: null,
      // One of each tri-state, so the fixture proves the difference rather than
      // just the true case: anticipated yes, MH asked and denied, the
      // unexplained-event question never asked at all.
      anticipatedDifficultAirway: true,
      malignantHyperthermiaHistory: false,
      unexplainedAnaesthesiaComplications: null,
      labResults: [],
      labRows: [
        { test: "Hemoglobin", valueNum: 180, value: "180", unitCanon: "g/L", loincCode: "718-7", abnormalFlag: "high", referenceLow: 130, referenceHigh: 175, standardConceptId: 3000963, mappingStatus: "MAPPED" },
        { test: "Unknown lab", valueNum: 7, value: "7", unitCanon: null, loincCode: null, abnormalFlag: null, referenceLow: null, referenceHigh: null, standardConceptId: null, mappingStatus: "UNMAPPED" },
        // A qualitative result. This used to be skipped entirely for having no
        // parsed number, so it left no trace of having been recorded.
        { test: "Urine culture", valueNum: null, value: "No growth", unitCanon: null, loincCode: null, abnormalFlag: "normal", referenceLow: null, referenceHigh: null, standardConceptId: null, mappingStatus: "SOURCE_ONLY" },
      ],
      diagnoses: [
        { code: "K35", label: "Acute appendicitis", labelEn: "Acute appendicitis", labelBg: null, sourceVocabulary: "ICD10", sourceCode: "K35", standardConceptId: 12345, mappingStatus: "MAPPED", ordinal: 0 },
      ],
      procedureRows: [
        { code: "APPY", group: "Appendectomy", domain: "LOSPOR_PROCEDURE", description: "Laparoscopic appendectomy", sourceVocabulary: "LOSPOR_PROCEDURE", sourceCode: "APPY", standardConceptId: 23456, mappingStatus: "MAPPED", ordinal: 0 },
        { code: "CHOLE", group: "Cholecystectomy", domain: "LOSPOR_PROCEDURE", description: "Laparoscopic cholecystectomy", sourceVocabulary: "LOSPOR_PROCEDURE", sourceCode: "CHOLE", standardConceptId: 34567, mappingStatus: "MAPPED", ordinal: 1 },
      ],
      comorbidityRows: [
        { label: "Source-only condition", labelEn: "Source-only condition", labelBg: null, code: "Z99", icd10Code: "Z99", sourceVocabulary: "ICD10", sourceCode: "Z99", standardConceptId: null, mappingStatus: "SOURCE_ONLY", ordinal: 0 },
      ],
      medications: [
        { kind: "CURRENT", nameRaw: "Diazepam", inn: "diazepam", atcCode: "N05BA01", dose: "5 mg", route: "PO", sourceVocabulary: "ATC", sourceCode: "N05BA01", standardConceptId: 19019905, mappingStatus: "MAPPED", ordinal: 0 },
      ],
    },
    intraop: {
      startTime,
      endTime,
      durationMinutes: 60,
      monthYear: "2026-06",
      techniques: ["general"],
      keyEvents: {},
      crystalloidsMl: 500,
      colloidsMl: 0,
      bloodMl: 0,
      urineMl: 100,
      complications: null,
      premedicationEvening: null,
      premedicationMorning: null,
      // Both the legacy single column and the current list are populated, as
      // they are on real rows written across the change, so the export has to
      // reconcile them rather than picking one.
      airwayDevice: "ORAL_ETT",
      airwayDevices: ["ORAL_ETT", "FACE_MASK"],
      cormackLehane: "IIa",
      airwayTools: ["VIDEO_LARY", "BOUGIE"],
      fob: false,
      lmaSize: null,
      oralTubeSize: 7.5,
      oralCuffed: true,
      nasalTubeSize: null,
      nasalCuffed: null,
      dltType: null,
      dltSide: null,
      dltSize: null,
      endobronchialSize: null,
      tubeSize: null,
      cuffed: null,
      ventilationModes: ["VCV"],
      ippv: true,
      jetVentilation: false,
      peepCmH2O: 5,
      vascularAccessRows: [{ site: "IJ", siteLabel: "Internal jugular", size: "18", sizeUnit: "G", depthCm: "8", lumens: "2", preexisting: true, ordinal: 0, sourceVocabulary: "LOSPOR_VASCULAR_ACCESS", sourceCode: "IJ_CVC", standardConceptId: 4052341, mappingStatus: "MAPPED" }],
      premedicationRows: [{ phase: "evening", nameRaw: "Midazolam 2 mg PO", inn: null, atcCode: null, standardConceptId: null, mappingStatus: "SOURCE_ONLY", dose: "2 mg", route: "PO", ordinal: 0 }],
    },
    postop: {
      aldreteActivity: 2,
      aldreteRespiration: 2,
      aldreteCirculation: 2,
      aldreteConsciousness: 2,
      aldreteSpO2: 2,
      aldreteTotal: 10,
      recoveryBpSystolic: 120,
      recoveryBpDiastolic: 70,
      recoveryHeartRate: 80,
      recoverySpO2: 98,
      temperatureCelsius: 36.8,
      painScoreNRS: 2,
      ponv: false,
      disposition: "WARD",
      complications: null,
    },
    ...overrides,
  }
}
