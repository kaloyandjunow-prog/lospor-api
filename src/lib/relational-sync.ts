import type { PrismaClient } from "@/generated/prisma/client"

// Mirror the JSON clinical arrays into queryable research rows.
//
// Reads from the AUTHORITATIVE JSON columns and reconciles child rows
// (delete + re-insert per section). Powers both live dual-write (called
// best-effort after case create/update) and the one-off backfill.
//
// SAFETY: called best-effort (caught) AFTER the main write commits.
// A failure here can NEVER roll back or block a clinical save.
// JSON stays the source of truth. Takes db as a parameter so backfill
// scripts can reuse without importing server-only modules.

type Db = PrismaClient
// JSON columns are untyped by definition — items are read defensively via
// optional chaining throughout this file, so Record<string, unknown> carries
// the same runtime behavior as `any` did, just without silencing real typos.
type JsonItem = Record<string, unknown>
const arr = (v: unknown): JsonItem[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (v == null ? null : String(v))
const SYNC_SOURCE = "relational-sync"
const SYNC_SOURCE_VERSION = "research-grade-v1"

const flt = (v: unknown): number | null => {
  const n = parseFloat(String(v ?? ""))
  return isFinite(n) ? n : null
}

type MappingStatus = "MAPPED" | "SOURCE_ONLY" | "UNMAPPED"
type ConceptInfo = {
  sourceVocabulary: string | null
  sourceCode: string | null
  standardConceptId: number | null
  mappingStatus: MappingStatus
}

let conceptCache: Map<string, ConceptInfo> | null = null

function conceptKey(domain: string, sourceVocabulary: string, sourceCode: string) {
  return `${domain}|${sourceVocabulary}|${sourceCode}`.toUpperCase()
}

async function getConceptMap(db: Db) {
  if (conceptCache) return conceptCache
  const rows = await db.conceptMap.findMany({
    where: { active: true },
    select: { domain: true, sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true },
  })
  conceptCache = new Map(rows.map(r => [conceptKey(r.domain, r.sourceVocabulary, r.sourceCode), {
    sourceVocabulary: r.sourceVocabulary,
    sourceCode: r.sourceCode,
    standardConceptId: r.standardConceptId,
    mappingStatus: r.mappingStatus as MappingStatus,
  }]))
  return conceptCache
}

function concept(
  concepts: Map<string, ConceptInfo>,
  domain: string,
  sourceVocabulary: string | null | undefined,
  sourceCode: string | null | undefined,
): ConceptInfo {
  if (!sourceVocabulary || !sourceCode) {
    return { sourceVocabulary: null, sourceCode: null, standardConceptId: null, mappingStatus: "UNMAPPED" }
  }
  return concepts.get(conceptKey(domain, sourceVocabulary, sourceCode)) ?? {
    sourceVocabulary,
    sourceCode,
    standardConceptId: null,
    mappingStatus: "SOURCE_ONLY",
  }
}

// LabLoinc cache (loaded once per process, tiny table)
let loincCache: Map<string, { loincCode: string; unitCanon: string; referenceLow: number | null; referenceHigh: number | null }> | null = null

async function getLoincMap(db: Db) {
  if (loincCache) return loincCache
  const rows = await db.labLoinc.findMany()
  loincCache = new Map(rows.map(r => [r.name, {
    loincCode:    r.loincCode,
    unitCanon:    r.unitCanon,
    referenceLow:  r.referenceLow,
    referenceHigh: r.referenceHigh,
  }]))
  return loincCache
}

function computeAbnormalFlag(value: number | null, low: number | null, high: number | null): string | null {
  if (value == null) return null
  if (high != null && value > high * 1.5) return "critical"
  if (low  != null && value < low  * 0.5) return "critical"
  if (high != null && value > high) return "high"
  if (low  != null && value < low)  return "low"
  return "normal"
}

function diagnosisRows(preopId: string, caseId: string, json: unknown, concepts: Map<string, ConceptInfo>) {
  return arr(json).map((d: JsonItem, i: number) => ({
    preopId, caseId,
    code:   str(d?.sub ?? d?.code),
    label:  String(d?.label ?? d?.code ?? d?.sub ?? "(unspecified)"),
    labelEn: str(d?.labelEn),
    labelBg: str(d?.labelBg),
    system: str(d?.system),
    ...concept(concepts, "condition", "ICD10", str(d?.sub ?? d?.code)),
    source: SYNC_SOURCE,
    sourceVersion: SYNC_SOURCE_VERSION,
    ordinal: i,
  }))
}

function procedureRows(preopId: string, caseId: string, json: unknown, concepts: Map<string, ConceptInfo>) {
  return arr(json).map((p: JsonItem, i: number) => ({
    preopId, caseId,
    code:        str(p?.sub ?? p?.code),
    group:       str(p?.group),
    domain:      str(p?.domain),
    description: str(p?.description ?? p?.label),
    ...concept(concepts, "procedure", str(p?.domain) ?? "LOSPOR_PROCEDURE", str(p?.sub ?? p?.code)),
    source: SYNC_SOURCE,
    sourceVersion: SYNC_SOURCE_VERSION,
    ordinal: i,
  }))
}

function comorbidityRows(preopId: string, caseId: string, json: unknown, concepts: Map<string, ConceptInfo>) {
  return arr(json).map((c: JsonItem, i: number) => {
    const rawCode = str(c?.sub ?? c?.code)
    // icd10Code: use sub/code if it looks like an ICD-10 code (letter + digits)
    const icd10Code = rawCode && /^[A-Za-z]\d/.test(rawCode) ? rawCode.toUpperCase() : null
    return {
      preopId, caseId,
      label:    String(c?.label ?? c?.sub ?? c?.code ?? "(unspecified)"),
      labelEn:  str(c?.labelEn),
      labelBg:  str(c?.labelBg),
      code:     rawCode,
      icd10Code,
      system:   str(c?.system),
      ...concept(concepts, "condition", "ICD10", icd10Code ?? rawCode),
      source: SYNC_SOURCE,
      sourceVersion: SYNC_SOURCE_VERSION,
      ordinal: i,
    }
  }).filter(r => r.label !== "(unspecified)" || r.code)
}

async function labRowsWithLoinc(
  preopId: string, caseId: string, json: unknown,
  loincMap: Map<string, { loincCode: string; unitCanon: string; referenceLow: number | null; referenceHigh: number | null }>,
  concepts: Map<string, ConceptInfo>,
) {
  return arr(json)
    .filter((l: JsonItem) => l && l.test != null)
    .map((l: JsonItem, i: number) => {
      const loinc = loincMap.get(String(l.test))
      const valueNum = flt(l?.value)
      const abnormalFlag = loinc
        ? computeAbnormalFlag(valueNum, loinc.referenceLow, loinc.referenceHigh)
        : null
      return {
        preopId, caseId,
        test:         String(l.test),
        value:        str(l?.value),
        valueNum,
        unit:         str(l?.unit),
        unitCanon:    loinc?.unitCanon ?? null,
        loincCode:    loinc?.loincCode ?? null,
        referenceLow:  loinc?.referenceLow ?? null,
        referenceHigh: loinc?.referenceHigh ?? null,
        abnormalFlag,
        source:       str(l?.source) ?? "manual",
        ...concept(concepts, "measurement", "LOINC", loinc?.loincCode ?? null),
        sourceVersion: SYNC_SOURCE_VERSION,
        ordinal: i,
      }
    })
}

function parseDrugList(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== "string" || !raw.trim()) return []
  const trimmed = raw.trim()
  if (trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed) } catch { return [] }
  }
  return trimmed
    .split(/[,\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => ({ label: s }))
}

function medicationRows(preopId: string, caseId: string, json: unknown, kind: "CURRENT" | "ALLERGY", concepts: Map<string, ConceptInfo>) {
  return arr(json)
    .filter((m: JsonItem) => m && (m.label || m.name || m.inn))
    .map((m: JsonItem, i: number) => {
      const atc = str(m.atc ?? m.atcCode)
      const inn = str(m.inn)
      const mapped = atc
        ? concept(concepts, "drug", "ATC", atc)
        : concept(concepts, "drug", inn ? "INN" : "LOSPOR_DRUG_RAW", inn ?? str(m.label ?? m.name))
      return {
        preopId, caseId,
        kind,
        nameRaw:   String(m.label ?? m.name ?? m.inn ?? ""),
        inn,
        atcCode:   atc,
        dose:      str(m.dose),
        route:     str(m.route),
        frequency: str(m.frequency),
        ...mapped,
        source: SYNC_SOURCE,
        sourceVersion: SYNC_SOURCE_VERSION,
        ordinal: i,
      }
    })
}

function vascularRows(intraopId: string, caseId: string, json: unknown, concepts: Map<string, ConceptInfo>) {
  return arr(json).map((v: JsonItem, i: number) => ({
    intraopId, caseId,
    site:      str(v?.site),
    siteLabel: str(v?.siteLabel),
    size:      str(v?.size),
    sizeUnit:  str(v?.sizeUnit),
    depthCm:   str(v?.depthCm),
    lumens:    str(v?.lumens),
    preexisting: v?.preexisting === true,
    ...concept(concepts, "procedure", "LOSPOR_VASCULAR_ACCESS", str(v?.site)),
    source: SYNC_SOURCE,
    sourceVersion: SYNC_SOURCE_VERSION,
    ordinal: i,
  }))
}

function complicationRows(caseId: string, section: "intraop" | "postop", raw: unknown, concepts: Map<string, ConceptInfo>) {
  if (typeof raw !== "string" || !raw.trim()) return []
  const parts = raw.split(";").map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) return []
  return parts.map((part, i) => {
    const dash = part.includes("—") ? "—" : part.includes(" - ") ? " - " : null
    const [labelRaw, noteRaw] = dash ? part.split(dash, 2).map(s => s.trim()) : [part, null]
    const label = labelRaw || "Unspecified complication"
    return {
      caseId,
      section,
      label,
      note: noteRaw ? noteRaw.slice(0, 500) : null,
      source: SYNC_SOURCE,
      ...concept(concepts, "observation", "LOSPOR_COMPLICATION", label),
      sourceVersion: SYNC_SOURCE_VERSION,
      ordinal: i,
    }
  })
}

function premedRows(intraopId: string, caseId: string, phase: "evening" | "morning", raw: unknown, concepts: Map<string, ConceptInfo>) {
  if (typeof raw !== "string" || !raw.trim()) return []
  const doseRe = /(\d+(?:\.\d+)?)\s*(mcg|mg|g|ml|mL|iu|IU|units?|tabs?|puffs?)/i
  const routeRe = /\b(PO|IV|IM|SC|SL|PR|INH|oral|intravenous|intramuscular|subcutaneous)\b/i
  return raw
    .split(/[;\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const doseMatch = entry.match(doseRe)
      const routeMatch = entry.match(routeRe)
      return {
        intraopId,
        caseId,
        phase,
        nameRaw: entry,
        dose: doseMatch ? `${doseMatch[1]} ${doseMatch[2]}` : null,
        route: routeMatch ? routeMatch[1].toUpperCase() : null,
        ...concept(concepts, "drug", "LOSPOR_DRUG_RAW", entry),
        source: SYNC_SOURCE,
        sourceVersion: SYNC_SOURCE_VERSION,
        ordinal: i,
      }
    })
}

function selectionRows(caseId: string, section: string, category: string, json: unknown, concepts: Map<string, ConceptInfo>) {
  return arr(json)
    .map((v: JsonItem | string) => (typeof v === "string" ? v : v?.value ?? v?.label))
    .filter((v: unknown): v is string => typeof v === "string" && v.length > 0)
    .map((value: string, i: number) => ({
      caseId, section, category, value,
      ...concept(concepts, "observation", "LOSPOR_OPTION", `${category}:${value}`),
      source: SYNC_SOURCE,
      sourceVersion: SYNC_SOURCE_VERSION,
      ordinal: i,
    }))
}

function booleanSelectionRows(caseId: string, section: string, category: string, values: Record<string, boolean | null | undefined>, concepts: Map<string, ConceptInfo>) {
  return Object.entries(values)
    .filter(([, enabled]) => enabled === true)
    .map(([value], ordinal) => ({
      caseId, section, category, value,
      ...concept(concepts, "observation", "LOSPOR_OPTION", `${category}:${value}`),
      source: SYNC_SOURCE,
      sourceVersion: SYNC_SOURCE_VERSION,
      ordinal,
    }))
}

function presence(v: unknown): "PRESENT" | "ABSENT" | "UNKNOWN" | "NOT_APPLICABLE" | "NOT_DOCUMENTED" {
  if (v === true) return "PRESENT"
  if (v === false) return "ABSENT"
  if (Array.isArray(v)) return v.length > 0 ? "PRESENT" : "NOT_DOCUMENTED"
  if (typeof v === "string") {
    const value = v.trim().toLowerCase()
    if (value === "not-applicable") return "NOT_APPLICABLE"
    if (value === "unknown") return "UNKNOWN"
    return value ? "PRESENT" : "NOT_DOCUMENTED"
  }
  return v == null ? "NOT_DOCUMENTED" : "PRESENT"
}

function fieldStatus(caseId: string, section: string, fieldKey: string, value: unknown) {
  return {
    caseId,
    section,
    fieldKey,
    presence: presence(value),
    source: SYNC_SOURCE,
    sourceVersion: SYNC_SOURCE_VERSION,
  }
}

export async function syncCaseRelational(db: Db, caseId: string): Promise<void> {
  const [c, loincMap, concepts] = await Promise.all([
    db.case.findUnique({
      where: { id: caseId },
      select: {
        status: true,
        preop:   { select: {
          id: true,
          ageYears: true, sex: true, heightCm: true, weightKg: true, bmi: true, bloodType: true, rhFactor: true,
          diagnosesJson: true, proceduresJson: true, comorbidities: true, labResults: true,
          currentMedications: true, allergies: true, allergyDetails: true, latexAllergy: true,
          familyAnesthesiaProblems: true, familyAnesthesiaDetails: true, dentalProsthetics: true, looseTeeth: true,
          smoking: true, substanceAbuse: true, bpSystolic: true, bpDiastolic: true, heartRate: true, spO2: true,
          temperature: true, respiratoryRate: true, bpUnobtainable: true, heartRateUnobtainable: true,
          spO2Unobtainable: true, temperatureUnobtainable: true, respiratoryRateUnobtainable: true,
          mallampati: true, mouthOpeningCm: true, thyromental: true, neckMobility: true, upperLipBiteTest: true,
          retrognathia: true, prominentIncisors: true, facialHair: true, difficultAirwayHistory: true,
          difficultAirwayNotes: true, cormackLehane: true, airwayUnobtainable: true, asaScore: true,
          elective: true, emergencySurgery: true, highRiskSurgery: true, rcriIschemicHeart: true, rcriCHF: true,
          rcriCVD: true, rcriInsulinDM: true, rcriCreatinine: true, rcriScore: true, gutaScore: true,
          apfelScore: true, apfelPONVHistory: true, apfelPostopOpioids: true, stopBangScore: true,
          stopbangSnoring: true, stopbangTired: true, stopbangObserved: true, stopbangBP: true, stopbangNeck: true,
          teamNotes: true, physicalExamReport: true, notes: true, aiOptIn: true,
        } },
        intraop: { select: {
          id: true, startTime: true, endTime: true, durationMinutes: true, monthYear: true,
          vascularAccesses: true, positions: true, techniques: true, airwayTools: true, airwayDevices: true, ventilationModes: true,
          airwayDevice: true, airwayNotes: true, cormackLehane: true, peepCmH2O: true, ippv: true, jetVentilation: true, fob: true,
          premedicationEvening: true, premedicationMorning: true, drugsAdministered: true,
          crystalloidsMl: true, colloidsMl: true, bloodMl: true, bloodProductsNote: true, urineMl: true,
          timeSeriesData: true, keyEvents: true, complications: true,
          ecg: true, spO2Monitor: true, nbpMonitor: true, etco2Monitor: true, tempMonitor: true, invasiveBP: true, cvpMonitor: true,
          bglMonitor: true, bloodGasMonitor: true, neuroMonitor: true, paCatheter: true, tee: true, bis: true, entropyMonitor: true,
          nirsMonitor: true, evokedPotentials: true, tofMonitor: true, urinaryCatheter: true, stomachTube: true,
        } },
        postop:  { select: {
          id: true, aldreteActivity: true, aldreteRespiration: true, aldreteCirculation: true, aldreteConsciousness: true,
          aldreteSpO2: true, aldreteTotal: true, recoveryBpSystolic: true, recoveryBpDiastolic: true,
          recoveryHeartRate: true, recoverySpO2: true, temperatureCelsius: true, painScoreNRS: true, ponv: true,
          recoveryBpUnobtainable: true, recoveryHeartRateUnobtainable: true, recoverySpO2Unobtainable: true,
          recoveryTemperatureUnobtainable: true, disposition: true, dispositionNotes: true, handoverItems: true, complications: true,
        } },
      },
    }),
    getLoincMap(db),
    getConceptMap(db),
  ])
  if (!c) return
  const statuses: ReturnType<typeof fieldStatus>[] = [
    fieldStatus(caseId, "case", "status", c.status),
  ]

  if (c.preop) {
    const p = c.preop
    const medJson = parseDrugList(p.currentMedications)
    const allergyJson = parseDrugList(p.allergyDetails)

    const labData = await labRowsWithLoinc(p.id, caseId, p.labResults, loincMap, concepts)
    statuses.push(
      fieldStatus(caseId, "preop", "ageYears", p.ageYears),
      fieldStatus(caseId, "preop", "sex", p.sex),
      fieldStatus(caseId, "preop", "heightCm", p.heightCm),
      fieldStatus(caseId, "preop", "weightKg", p.weightKg),
      fieldStatus(caseId, "preop", "bmi", p.bmi),
      fieldStatus(caseId, "preop", "bloodType", p.bloodType),
      fieldStatus(caseId, "preop", "rhFactor", p.rhFactor),
      fieldStatus(caseId, "preop", "diagnoses", p.diagnosesJson),
      fieldStatus(caseId, "preop", "procedures", p.proceduresJson),
      fieldStatus(caseId, "preop", "comorbidities", p.comorbidities),
      fieldStatus(caseId, "preop", "labResults", p.labResults),
      fieldStatus(caseId, "preop", "currentMedications", p.currentMedications),
      fieldStatus(caseId, "preop", "allergies", p.allergies),
      fieldStatus(caseId, "preop", "medicationAllergies", p.allergyDetails),
      fieldStatus(caseId, "preop", "latexAllergy", p.latexAllergy),
      fieldStatus(caseId, "preop", "familyAnesthesiaProblems", p.familyAnesthesiaProblems),
      fieldStatus(caseId, "preop", "familyAnesthesiaDetails", p.familyAnesthesiaProblems ? p.familyAnesthesiaDetails : null),
      fieldStatus(caseId, "preop", "dentalProsthetics", p.dentalProsthetics),
      fieldStatus(caseId, "preop", "looseTeeth", p.looseTeeth),
      fieldStatus(caseId, "preop", "smoking", p.smoking),
      fieldStatus(caseId, "preop", "substanceAbuse", p.substanceAbuse),
      fieldStatus(caseId, "preop", "bpSystolic", p.bpUnobtainable ? "not-applicable" : p.bpSystolic),
      fieldStatus(caseId, "preop", "bpDiastolic", p.bpUnobtainable ? "not-applicable" : p.bpDiastolic),
      fieldStatus(caseId, "preop", "heartRate", p.heartRateUnobtainable ? "not-applicable" : p.heartRate),
      fieldStatus(caseId, "preop", "spO2", p.spO2Unobtainable ? "not-applicable" : p.spO2),
      fieldStatus(caseId, "preop", "temperature", p.temperatureUnobtainable ? "not-applicable" : p.temperature),
      fieldStatus(caseId, "preop", "respiratoryRate", p.respiratoryRateUnobtainable ? "not-applicable" : p.respiratoryRate),
      fieldStatus(caseId, "preop", "mallampati", p.airwayUnobtainable ? "not-applicable" : p.mallampati),
      fieldStatus(caseId, "preop", "mouthOpeningCm", p.airwayUnobtainable ? "not-applicable" : p.mouthOpeningCm),
      fieldStatus(caseId, "preop", "thyromental", p.airwayUnobtainable ? "not-applicable" : p.thyromental),
      fieldStatus(caseId, "preop", "neckMobility", p.airwayUnobtainable ? "not-applicable" : p.neckMobility),
      fieldStatus(caseId, "preop", "upperLipBiteTest", p.airwayUnobtainable ? "not-applicable" : p.upperLipBiteTest),
      fieldStatus(caseId, "preop", "retrognathia", p.retrognathia),
      fieldStatus(caseId, "preop", "prominentIncisors", p.prominentIncisors),
      fieldStatus(caseId, "preop", "facialHair", p.facialHair),
      fieldStatus(caseId, "preop", "difficultAirwayHistory", p.difficultAirwayHistory),
      fieldStatus(caseId, "preop", "difficultAirwayNotes", p.difficultAirwayHistory ? p.difficultAirwayNotes : null),
      fieldStatus(caseId, "preop", "cormackLehane", p.cormackLehane),
      fieldStatus(caseId, "preop", "asaScore", p.asaScore),
      fieldStatus(caseId, "preop", "elective", p.elective),
      fieldStatus(caseId, "preop", "emergencySurgery", p.emergencySurgery),
      fieldStatus(caseId, "preop", "highRiskSurgery", p.highRiskSurgery),
      fieldStatus(caseId, "preop", "rcriScore", p.rcriScore),
      fieldStatus(caseId, "preop", "gutaScore", p.gutaScore),
      fieldStatus(caseId, "preop", "apfelScore", p.apfelScore),
      fieldStatus(caseId, "preop", "stopBangScore", p.stopBangScore),
      fieldStatus(caseId, "preop", "teamNotes", p.teamNotes),
      fieldStatus(caseId, "preop", "physicalExamReport", p.physicalExamReport),
      fieldStatus(caseId, "preop", "notes", p.notes),
      fieldStatus(caseId, "preop", "aiOptIn", p.aiOptIn),
    )

    // Sequential writes — PgBouncer Transaction-mode (port 6543) cannot sustain
    // interactive $transaction([...]) calls → P2028. Atomicity is not required here
    // because this is a research mirror; the JSON columns stay authoritative.
    await db.preopDiagnosis.deleteMany({ where: { preopId: p.id } })
    await db.preopDiagnosis.createMany({ data: diagnosisRows(p.id, caseId, p.diagnosesJson, concepts) })
    await db.preopProcedure.deleteMany({ where: { preopId: p.id } })
    await db.preopProcedure.createMany({ data: procedureRows(p.id, caseId, p.proceduresJson, concepts) })
    await db.comorbidity.deleteMany({ where: { preopId: p.id } })
    await db.comorbidity.createMany({ data: comorbidityRows(p.id, caseId, p.comorbidities, concepts) })
    await db.labResult.deleteMany({ where: { preopId: p.id } })
    await db.labResult.createMany({ data: labData })
    await db.medication.deleteMany({ where: { preopId: p.id } })
    await db.medication.createMany({ data: [
      ...medicationRows(p.id, caseId, medJson, "CURRENT", concepts),
      ...medicationRows(p.id, caseId, allergyJson, "ALLERGY", concepts),
    ] })
  }

  if (c.intraop) {
    const it = c.intraop
    const monitoring = booleanSelectionRows(caseId, "intraop", "monitoring", {
      ecg: it.ecg,
      spO2Monitor: it.spO2Monitor,
      nbpMonitor: it.nbpMonitor,
      etco2Monitor: it.etco2Monitor,
      tempMonitor: it.tempMonitor,
      invasiveBP: it.invasiveBP,
      cvpMonitor: it.cvpMonitor,
      bglMonitor: it.bglMonitor,
      bloodGasMonitor: it.bloodGasMonitor,
      neuroMonitor: it.neuroMonitor,
      paCatheter: it.paCatheter,
      tee: it.tee,
      bis: it.bis,
      entropyMonitor: it.entropyMonitor,
      nirsMonitor: it.nirsMonitor,
      evokedPotentials: it.evokedPotentials,
      tofMonitor: it.tofMonitor,
      urinaryCatheter: it.urinaryCatheter,
      stomachTube: it.stomachTube,
    }, concepts)
    const selections = [
      ...selectionRows(caseId, "intraop", "position",        it.positions, concepts),
      ...selectionRows(caseId, "intraop", "technique",       it.techniques, concepts),
      ...selectionRows(caseId, "intraop", "airwayTool",      it.airwayTools, concepts),
      ...selectionRows(caseId, "intraop", "airwayDevice",    it.airwayDevices, concepts),
      ...selectionRows(caseId, "intraop", "ventilationMode", it.ventilationModes, concepts),
      ...monitoring,
    ]
    statuses.push(
      fieldStatus(caseId, "intraop", "startTime", it.startTime),
      fieldStatus(caseId, "intraop", "endTime", it.endTime),
      fieldStatus(caseId, "intraop", "durationMinutes", it.durationMinutes),
      fieldStatus(caseId, "intraop", "monthYear", it.monthYear),
      fieldStatus(caseId, "intraop", "vascularAccesses", it.vascularAccesses),
      fieldStatus(caseId, "intraop", "positions", it.positions),
      fieldStatus(caseId, "intraop", "techniques", it.techniques),
      fieldStatus(caseId, "intraop", "airwayTools", it.airwayTools),
      fieldStatus(caseId, "intraop", "airwayDevices", it.airwayDevices),
      fieldStatus(caseId, "intraop", "airwayDevice", it.airwayDevice),
      fieldStatus(caseId, "intraop", "airwayNotes", it.airwayNotes),
      fieldStatus(caseId, "intraop", "cormackLehane", it.cormackLehane),
      fieldStatus(caseId, "intraop", "peepCmH2O", it.peepCmH2O),
      fieldStatus(caseId, "intraop", "ippv", it.ippv),
      fieldStatus(caseId, "intraop", "jetVentilation", it.jetVentilation),
      fieldStatus(caseId, "intraop", "fob", it.fob),
      fieldStatus(caseId, "intraop", "ventilationModes", it.ventilationModes),
      fieldStatus(caseId, "intraop", "monitoring", monitoring),
      fieldStatus(caseId, "intraop", "premedicationEvening", it.premedicationEvening),
      fieldStatus(caseId, "intraop", "premedicationMorning", it.premedicationMorning),
      fieldStatus(caseId, "intraop", "drugsAdministered", it.drugsAdministered),
      fieldStatus(caseId, "intraop", "crystalloidsMl", it.crystalloidsMl),
      fieldStatus(caseId, "intraop", "colloidsMl", it.colloidsMl),
      fieldStatus(caseId, "intraop", "bloodMl", it.bloodMl),
      fieldStatus(caseId, "intraop", "bloodProductsNote", it.bloodProductsNote),
      fieldStatus(caseId, "intraop", "urineMl", it.urineMl),
      fieldStatus(caseId, "intraop", "timeSeriesData", it.timeSeriesData),
      fieldStatus(caseId, "intraop", "keyEvents", it.keyEvents),
      fieldStatus(caseId, "intraop", "complications", it.complications),
    )
    await db.vascularAccess.deleteMany({ where: { intraopId: it.id } })
    await db.vascularAccess.createMany({ data: vascularRows(it.id, caseId, it.vascularAccesses, concepts) })
    await db.premedicationAdministration.deleteMany({ where: { intraopId: it.id } })
    await db.premedicationAdministration.createMany({ data: [
      ...premedRows(it.id, caseId, "evening", it.premedicationEvening, concepts),
      ...premedRows(it.id, caseId, "morning", it.premedicationMorning, concepts),
    ] })
    await db.caseComplication.deleteMany({ where: { caseId, section: "intraop" } })
    await db.caseComplication.createMany({ data: complicationRows(caseId, "intraop", it.complications, concepts) })
    await db.caseSelection.deleteMany({ where: { caseId, section: "intraop" } })
    await db.caseSelection.createMany({ data: selections })
  }

  if (c.postop) {
    const selections = selectionRows(caseId, "postop", "handoverItem", c.postop.handoverItems, concepts)
    statuses.push(
      fieldStatus(caseId, "postop", "aldreteActivity", c.postop.aldreteActivity),
      fieldStatus(caseId, "postop", "aldreteRespiration", c.postop.aldreteRespiration),
      fieldStatus(caseId, "postop", "aldreteCirculation", c.postop.aldreteCirculation),
      fieldStatus(caseId, "postop", "aldreteConsciousness", c.postop.aldreteConsciousness),
      fieldStatus(caseId, "postop", "aldreteSpO2", c.postop.aldreteSpO2),
      fieldStatus(caseId, "postop", "aldreteTotal", c.postop.aldreteTotal),
      fieldStatus(caseId, "postop", "recoveryBpSystolic", c.postop.recoveryBpUnobtainable ? "not-applicable" : c.postop.recoveryBpSystolic),
      fieldStatus(caseId, "postop", "recoveryBpDiastolic", c.postop.recoveryBpUnobtainable ? "not-applicable" : c.postop.recoveryBpDiastolic),
      fieldStatus(caseId, "postop", "recoveryHeartRate", c.postop.recoveryHeartRateUnobtainable ? "not-applicable" : c.postop.recoveryHeartRate),
      fieldStatus(caseId, "postop", "recoverySpO2", c.postop.recoverySpO2Unobtainable ? "not-applicable" : c.postop.recoverySpO2),
      fieldStatus(caseId, "postop", "temperatureCelsius", c.postop.recoveryTemperatureUnobtainable ? "not-applicable" : c.postop.temperatureCelsius),
      fieldStatus(caseId, "postop", "painScoreNRS", c.postop.painScoreNRS),
      fieldStatus(caseId, "postop", "ponv", c.postop.ponv),
      fieldStatus(caseId, "postop", "disposition", c.postop.disposition),
      fieldStatus(caseId, "postop", "dispositionNotes", c.postop.dispositionNotes),
      fieldStatus(caseId, "postop", "handoverItems", c.postop.handoverItems),
      fieldStatus(caseId, "postop", "complications", c.postop.complications),
    )
    await db.caseComplication.deleteMany({ where: { caseId, section: "postop" } })
    await db.caseComplication.createMany({ data: complicationRows(caseId, "postop", c.postop.complications, concepts) })
    await db.caseSelection.deleteMany({ where: { caseId, section: "postop" } })
    await db.caseSelection.createMany({ data: selections })
  }

  await db.clinicalFieldStatus.deleteMany({ where: { caseId } })
  // skipDuplicates guards against two overlapping saves for the same case
  // both deleting then recreating this case's rows — without it, the second
  // createMany throws P2002 on the (caseId, section, fieldKey) unique
  // constraint. No $transaction here (see comment above) so this is the
  // available guard; a duplicate row is safe to skip since this table is a
  // rebuildable research mirror, not source-of-truth data.
  await db.clinicalFieldStatus.createMany({ data: statuses, skipDuplicates: true })
}

// userId is optional context for the audit trail only — sync itself is not
// scoped to a user. Passing it lets failures show up in the audit log
// (admin-visible drift signal) instead of only a server console line that's
// lost on the next deploy/restart and invisible across serverless instances.
export function syncCaseRelationalSafe(db: Db, caseId: string, userId?: string): Promise<void> {
  return syncCaseRelational(db, caseId).catch(err => {
    console.error("[relational-sync]", caseId, err)
    if (userId) {
      import("@/lib/audit").then(({ logAudit }) =>
        logAudit(userId, "RELATIONAL_SYNC_FAILED", caseId, { error: String(err?.message ?? err) })
      ).catch(() => {})
    }
  })
}
