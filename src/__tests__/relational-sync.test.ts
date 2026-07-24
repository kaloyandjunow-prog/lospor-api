import { beforeEach, describe, expect, it, vi } from "vitest"

const logAuditMock = vi.fn()

vi.mock("@/lib/audit", () => ({ logAudit: logAuditMock }))

type Delegate = {
  deleteMany: ReturnType<typeof vi.fn>
  createMany: ReturnType<typeof vi.fn>
}

function delegate(): Delegate {
  return {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  }
}

function makeDb(caseRow: Record<string, unknown>) {
  return {
    case: { findUnique: vi.fn().mockResolvedValue(caseRow) },
    conceptMap: {
      findMany: vi.fn().mockResolvedValue([
        { domain: "condition", sourceVocabulary: "ICD10", sourceCode: "K35", standardConceptId: 12345, mappingStatus: "MAPPED" },
        { domain: "procedure", sourceVocabulary: "LOSPOR_PROCEDURE", sourceCode: "APPY", standardConceptId: 23456, mappingStatus: "MAPPED" },
        { domain: "measurement", sourceVocabulary: "LOINC", sourceCode: "718-7", standardConceptId: 3000963, mappingStatus: "MAPPED" },
        { domain: "drug", sourceVocabulary: "ATC", sourceCode: "N05BA01", standardConceptId: 19019905, mappingStatus: "MAPPED" },
        { domain: "procedure", sourceVocabulary: "LOSPOR_VASCULAR_ACCESS", sourceCode: "IJ", standardConceptId: 433590, mappingStatus: "MAPPED" },
      ]),
    },
    labLoinc: {
      findMany: vi.fn().mockResolvedValue([
        { name: "Hemoglobin", loincCode: "718-7", unitCanon: "g/L", referenceLow: 120, referenceHigh: 160 },
      ]),
    },
    preopDiagnosis: delegate(),
    preopProcedure: delegate(),
    comorbidity: delegate(),
    labResult: delegate(),
    medication: delegate(),
    vascularAccess: delegate(),
    premedicationAdministration: delegate(),
    caseComplication: delegate(),
    caseSelection: delegate(),
    clinicalFieldStatus: delegate(),
  }
}

function makeCaseRow() {
  return {
    status: "IN_PROGRESS",
    preop: {
      id: "preop-1",
      ageYears: 14,
      sex: "MALE",
      heightCm: 165,
      weightKg: 60,
      bmi: 22,
      bloodType: "A",
      rhFactor: "POS",
      diagnosesJson: [
        { code: "K35", label: "Acute appendicitis", labelEn: "Acute appendicitis", labelBg: "Остър апендицит", system: "ICD10" },
        { code: "Z99", label: "Source-only diagnosis" },
        { label: "Uncoded diagnosis" },
      ],
      proceduresJson: [
        { code: "APPY", group: "Appendectomy", domain: "LOSPOR_PROCEDURE", description: "Laparoscopic appendectomy" },
      ],
      comorbidities: [
        { code: "K35", label: "Appendicitis history", labelEn: "Appendicitis history" },
      ],
      labResults: [
        { test: "Hemoglobin", value: "180", unit: "g/L", source: "scan" },
        { test: "Unknown lab", value: "7", unit: "x" },
      ],
      currentMedications: JSON.stringify([
        { label: "Diazepam", inn: "diazepam", atc: "N05BA01", dose: "5 mg", route: "PO", frequency: "night" },
      ]),
      allergies: true,
      allergyDetails: "Penicillin",
      latexAllergy: false,
      familyAnesthesiaProblems: false,
      familyAnesthesiaDetails: "ignore when false",
      dentalProsthetics: false,
      looseTeeth: false,
      smoking: false,
      substanceAbuse: false,
      bpSystolic: 126,
      bpDiastolic: 74,
      heartRate: 82,
      spO2: 99,
      temperature: 36.7,
      respiratoryRate: 14,
      bpUnobtainable: false,
      heartRateUnobtainable: false,
      spO2Unobtainable: false,
      temperatureUnobtainable: false,
      respiratoryRateUnobtainable: false,
      mallampati: "I",
      mouthOpeningCm: 4,
      thyromental: ">9",
      neckMobility: "normal",
      upperLipBiteTest: "I",
      retrognathia: false,
      prominentIncisors: false,
      facialHair: false,
      difficultAirwayHistory: false,
      difficultAirwayNotes: null,
      cormackLehane: null,
      airwayUnobtainable: false,
      asaScore: "I",
      elective: true,
      emergencySurgery: false,
      highRiskSurgery: false,
      rcriIschemicHeart: false,
      rcriCHF: false,
      rcriCVD: false,
      rcriInsulinDM: false,
      rcriCreatinine: false,
      rcriScore: 0,
      gutaScore: 0,
      apfelScore: 1,
      apfelPONVHistory: false,
      apfelPostopOpioids: true,
      stopBangScore: 1,
      stopbangSnoring: false,
      stopbangTired: false,
      stopbangObserved: false,
      stopbangBP: false,
      stopbangNeck: false,
      teamNotes: "",
      physicalExamReport: "",
      notes: "",
      aiOptIn: true,
    },
    intraop: {
      id: "intraop-1",
      startTime: new Date("2026-06-01T08:00:00Z"),
      endTime: new Date("2026-06-01T09:00:00Z"),
      durationMinutes: 60,
      monthYear: "2026-06",
      vascularAccesses: [
        { site: "IJ", siteLabel: "Internal jugular", size: "18", sizeUnit: "G", depthCm: "8", lumens: "2", preexisting: true },
      ],
      positions: ["supine"],
      techniques: ["general"],
      airwayTools: ["video"],
      airwayDevices: ["ett"],
      ventilationModes: ["ippv"],
      airwayDevice: "ett",
      airwayNotes: "",
      cormackLehane: "I",
      peepCmH2O: 5,
      ippv: true,
      jetVentilation: false,
      fob: false,
      premedicationEvening: "Midazolam 2 mg PO",
      premedicationMorning: "",
      drugsAdministered: [],
      crystalloidsMl: 500,
      colloidsMl: 0,
      bloodMl: 0,
      bloodProductsNote: "",
      urineMl: 100,
      timeSeriesData: [],
      keyEvents: {},
      complications: "Laryngospasm - brief desaturation",
      ecg: true,
      spO2Monitor: true,
      nbpMonitor: true,
      etco2Monitor: true,
      tempMonitor: true,
      invasiveBP: false,
      cvpMonitor: false,
      bglMonitor: false,
      bloodGasMonitor: false,
      neuroMonitor: false,
      paCatheter: false,
      tee: false,
      bis: false,
      entropyMonitor: false,
      nirsMonitor: false,
      evokedPotentials: false,
      tofMonitor: false,
      urinaryCatheter: true,
      stomachTube: false,
    },
    postop: {
      id: "postop-1",
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
      recoveryBpUnobtainable: false,
      recoveryHeartRateUnobtainable: false,
      recoverySpO2Unobtainable: false,
      recoveryTemperatureUnobtainable: false,
      disposition: "WARD",
      dispositionNotes: "",
      handoverItems: ["pain"],
      complications: "PONV",
    },
  }
}

describe("syncCaseRelational", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("mirrors canonical clinical JSON into mapped relational rows", async () => {
    const { syncCaseRelational } = await import("@/lib/relational-sync")
    const db = makeDb(makeCaseRow())

    await syncCaseRelational(db as never, "case-1")

    expect(db.preopDiagnosis.deleteMany).toHaveBeenCalledWith({ where: { preopId: "preop-1" } })
    expect(db.preopDiagnosis.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          code: "K35",
          label: "Acute appendicitis",
          sourceVocabulary: "ICD10",
          sourceCode: "K35",
          standardConceptId: 12345,
          mappingStatus: "MAPPED",
          ordinal: 0,
        }),
        expect.objectContaining({
          code: "Z99",
          sourceVocabulary: "ICD10",
          sourceCode: "Z99",
          standardConceptId: null,
          mappingStatus: "SOURCE_ONLY",
          ordinal: 1,
        }),
        expect.objectContaining({
          code: null,
          sourceVocabulary: null,
          sourceCode: null,
          standardConceptId: null,
          mappingStatus: "UNMAPPED",
          ordinal: 2,
        }),
      ],
    })
    expect(db.preopProcedure.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          code: "APPY",
          group: "Appendectomy",
          domain: "LOSPOR_PROCEDURE",
          sourceVocabulary: "LOSPOR_PROCEDURE",
          sourceCode: "APPY",
          standardConceptId: 23456,
          mappingStatus: "MAPPED",
        }),
      ],
    })
    expect(db.labResult.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          test: "Hemoglobin",
          valueNum: 180,
          unitCanon: "g/L",
          loincCode: "718-7",
          abnormalFlag: "high",
          standardConceptId: 3000963,
          mappingStatus: "MAPPED",
          source: "scan",
        }),
        expect.objectContaining({
          test: "Unknown lab",
          loincCode: null,
          unitCanon: null,
          mappingStatus: "UNMAPPED",
        }),
      ],
    })
    expect(db.medication.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          kind: "CURRENT",
          nameRaw: "Diazepam",
          atcCode: "N05BA01",
          standardConceptId: 19019905,
          mappingStatus: "MAPPED",
        }),
        expect.objectContaining({
          kind: "ALLERGY",
          nameRaw: "Penicillin",
          sourceVocabulary: "LOSPOR_DRUG_RAW",
          sourceCode: "Penicillin",
          mappingStatus: "SOURCE_ONLY",
        }),
      ]),
    })
    expect(db.vascularAccess.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          site: "IJ",
          siteLabel: "Internal jugular",
          depthCm: "8",
          lumens: "2",
          preexisting: true,
          standardConceptId: 433590,
          mappingStatus: "MAPPED",
        }),
      ],
    })
    expect(db.caseComplication.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ caseId: "case-1", section: "intraop", label: "Laryngospasm", note: "brief desaturation" }),
      ],
    })
    expect(db.caseComplication.createMany).toHaveBeenLastCalledWith({
      data: [
        expect.objectContaining({ caseId: "case-1", section: "postop", label: "PONV", note: null }),
      ],
    })
    expect(db.clinicalFieldStatus.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ caseId: "case-1", section: "preop", fieldKey: "ageYears", presence: "PRESENT" }),
        expect.objectContaining({ caseId: "case-1", section: "preop", fieldKey: "familyAnesthesiaDetails", presence: "NOT_DOCUMENTED" }),
        expect.objectContaining({ caseId: "case-1", section: "intraop", fieldKey: "monitoring", presence: "PRESENT" }),
      ]),
      skipDuplicates: true,
    })
    expect(db.preopDiagnosis.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(db.preopDiagnosis.createMany.mock.invocationCallOrder[0])
    expect(db.clinicalFieldStatus.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(db.clinicalFieldStatus.createMany.mock.invocationCallOrder[0])
  })

  it("does not append stale rows when sections are empty", async () => {
    const { syncCaseRelational } = await import("@/lib/relational-sync")
    const row = makeCaseRow()
    row.preop.diagnosesJson = []
    row.preop.proceduresJson = []
    row.preop.comorbidities = []
    row.preop.labResults = []
    row.preop.currentMedications = ""
    row.preop.allergyDetails = ""
    row.intraop.vascularAccesses = []
    row.intraop.complications = ""
    row.postop.complications = ""
    const db = makeDb(row)

    await syncCaseRelational(db as never, "case-1")

    expect(db.preopDiagnosis.createMany).toHaveBeenCalledWith({ data: [] })
    expect(db.preopProcedure.createMany).toHaveBeenCalledWith({ data: [] })
    expect(db.comorbidity.createMany).toHaveBeenCalledWith({ data: [] })
    expect(db.labResult.createMany).toHaveBeenCalledWith({ data: [] })
    expect(db.medication.createMany).toHaveBeenCalledWith({ data: [] })
    expect(db.vascularAccess.createMany).toHaveBeenCalledWith({ data: [] })
    expect(db.caseComplication.createMany).toHaveBeenNthCalledWith(1, { data: [] })
    expect(db.caseComplication.createMany).toHaveBeenNthCalledWith(2, { data: [] })
  })

  it("records an audit event when best-effort sync fails", async () => {
    const { syncCaseRelationalSafe } = await import("@/lib/relational-sync")
    const db = makeDb(makeCaseRow())
    db.case.findUnique.mockRejectedValue(new Error("database unavailable"))

    await syncCaseRelationalSafe(db as never, "case-1", "user-1")
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(logAuditMock).toHaveBeenCalledWith("user-1", "RELATIONAL_SYNC_FAILED", "case-1", { error: "database unavailable" })
  })
})
