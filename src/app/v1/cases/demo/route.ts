/**
 * GET /api/cases/demo
 * Returns (or creates) a read-only demo case for the current user to browse.
 * The case is marked via notes="__DEMO__" so it can be identified and excluded from real stats.
 */
import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma }  from "@/lib/prisma"

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const userId = user.id

  // Re-use existing IN_PROGRESS demo case; delete stale COMPLETE ones
  const existing = await prisma.case.findFirst({
    where: { userId, notes: "__DEMO__" },
    select: { id: true, status: true },
  })
  if (existing) {
    if (existing.status === "IN_PROGRESS") return NextResponse.json({ id: existing.id })
    // Stale COMPLETE demo — delete and recreate
    await prisma.case.delete({ where: { id: existing.id } })
  }

  // Create a realistic demo case: colectomy, 70yo male, colon cancer, 3h case
  const caseRecord = await prisma.case.create({
    data: {
      userId,
      notes:  "__DEMO__",
      status: "IN_PROGRESS",
      preop: {
        create: {
          ageYears: 70,
          sex:      "MALE",
          heightCm: 172,
          weightKg: 78,
          bmi:      26.4,
          diagnosis: "C18.9 — Malignant neoplasm of colon, unspecified",
          plannedProcedure: "Colectomy; Robotic-assisted procedures",
          icdCode: "2B90.Z",
          teamNotes: "Robotic theatre — see attached equipment checklist",
          comorbidities: [
            { label: "Essential hypertension",       sub: "BA00" },
            { label: "Type 2 diabetes mellitus",     sub: "5A11" },
            { label: "Ischaemic heart disease",      sub: "BA80" },
          ],
          allergies:        false,
          latexAllergy:     false,
          currentMedications: "Metoprolol 50mg od; Metformin 1000mg bd; Aspirin 100mg od; Lisinopril 10mg od",
          familyAnesthesiaProblems: false,
          bpSystolic:   148,
          bpDiastolic:   88,
          heartRate:     72,
          spO2:          96,
          temperature:   36.6,
          respiratoryRate: 16,
          mallampati:    "II",
          mouthOpeningCm: 4.5,
          thyromental:   7.0,
          neckMobility:  "FULL",
          asaScore:      "III",
          emergencySurgery: false,
          rcriScore:     2,
          apfelScore:    1,
          stopBangScore: 3,
          labResults: [
            { test: "Hb",    value: "118",  unit: "g/L"   },
            { test: "Hct",   value: "0.35", unit: "L/L"   },
            { test: "PLT",   value: "210",  unit: "×10⁹/L" },
            { test: "INR",   value: "1.1",  unit: ""       },
            { test: "Creat", value: "98",   unit: "μmol/L" },
            { test: "K⁺",    value: "4.1",  unit: "mmol/L" },
            { test: "Na⁺",   value: "138",  unit: "mmol/L" },
            { test: "Gluc",  value: "7.2",  unit: "mmol/L" },
          ],
        },
      },
      intraop: {
        create: {
          premedicationEvening: "Midazolam 7.5mg PO",
          premedicationMorning: "Omeprazole 40mg PO",
          monthYear: "2026-05",
          startTime: new Date("2000-01-01T07:30:00Z"),
          endTime:   new Date("2000-01-01T10:45:00Z"),
          positions:       ["SUPINE"],
          techniques:      ["GENERAL_INHALATION", "EPIDURAL"],
          airwayDevices:   ["ORAL_ETT"],
          oralTubeSize:    8,
          oralCuffed:      true,
          airwayTools:     ["DIRECT_LARY"],
          cormackLehane:   "IIa",
          ventilationModes:["VCV"],
          volatileAgent:   "SEVOFLURANE",
          ecg:             true,
          spO2Monitor:     true,
          nbpMonitor:      true,
          etco2Monitor:    true,
          tempMonitor:     true,
          invasiveBP:      true,
          cvpMonitor:      false,
          urinaryCatheter: true,
          stomachTube:     true,
          bglMonitor:      true,
          tofMonitor:      true,
          vascularAccesses: [
            { site: "PERIPHERAL_IV", siteLabel: "Peripheral IV", size: "18", sizeUnit: "G" },
            { site: "PERIPHERAL_IV", siteLabel: "Peripheral IV", size: "16", sizeUnit: "G" },
            { site: "EPIDURAL",      siteLabel: "Epidural",      size: "18", sizeUnit: "G" },
          ],
          crystalloidsMl: 1500,
          colloidsMl:     500,
          bloodMl:        0,
          urineMl:        350,
          complications:  "Hypotension; Transient bradycardia",
          keyEvents: {
            vitals: [
              { systolic: 148, diastolic: 88,  heartRate: 72, spO2: 96, etco2: null },
              { systolic: 132, diastolic: 80,  heartRate: 70, spO2: 99, etco2: 36   },
              { systolic: 118, diastolic: 72,  heartRate: 68, spO2: 99, etco2: 35   },
              { systolic: 95,  diastolic: 60,  heartRate: 74, spO2: 98, etco2: 34   },
              { systolic: 88,  diastolic: 54,  heartRate: 82, spO2: 97, etco2: 33   },
              { systolic: 102, diastolic: 65,  heartRate: 76, spO2: 98, etco2: 35   },
              { systolic: 110, diastolic: 70,  heartRate: 72, spO2: 99, etco2: 36   },
              { systolic: 118, diastolic: 74,  heartRate: 70, spO2: 99, etco2: 36   },
              { systolic: 122, diastolic: 76,  heartRate: 68, spO2: 99, etco2: 35   },
              { systolic: 125, diastolic: 78,  heartRate: 70, spO2: 99, etco2: 36   },
              { systolic: 128, diastolic: 80,  heartRate: 72, spO2: 98, etco2: 35   },
              { systolic: 130, diastolic: 80,  heartRate: 74, spO2: 99, etco2: 36   },
              { systolic: 128, diastolic: 78,  heartRate: 72, spO2: 99, etco2: 36   },
              { systolic: 126, diastolic: 76,  heartRate: 70, spO2: 99, etco2: 35   },
              { systolic: 124, diastolic: 76,  heartRate: 71, spO2: 99, etco2: 36   },
              { systolic: 122, diastolic: 75,  heartRate: 72, spO2: 99, etco2: 35   },
              { systolic: 120, diastolic: 74,  heartRate: 70, spO2: 98, etco2: 35   },
              { systolic: 118, diastolic: 73,  heartRate: 69, spO2: 99, etco2: 36   },
              { systolic: 120, diastolic: 74,  heartRate: 71, spO2: 99, etco2: 36   },
              { systolic: 122, diastolic: 76,  heartRate: 72, spO2: 99, etco2: 35   },
              { systolic: 124, diastolic: 76,  heartRate: 70, spO2: 98, etco2: 35   },
              { systolic: 126, diastolic: 77,  heartRate: 71, spO2: 99, etco2: 36   },
              { systolic: 128, diastolic: 78,  heartRate: 72, spO2: 99, etco2: 36   },
              { systolic: 130, diastolic: 79,  heartRate: 72, spO2: 99, etco2: 36   },
              { systolic: 132, diastolic: 80,  heartRate: 74, spO2: 98, etco2: 35   },
              { systolic: 134, diastolic: 82,  heartRate: 74, spO2: 99, etco2: 36   },
              { systolic: 136, diastolic: 82,  heartRate: 73, spO2: 99, etco2: 36   },
              { systolic: 134, diastolic: 80,  heartRate: 72, spO2: 99, etco2: 35   },
              { systolic: 132, diastolic: 80,  heartRate: 72, spO2: 98, etco2: 35   },
              { systolic: 130, diastolic: 79,  heartRate: 70, spO2: 99, etco2: 36   },
              { systolic: 128, diastolic: 78,  heartRate: 70, spO2: 99, etco2: 36   },
              { systolic: 126, diastolic: 76,  heartRate: 71, spO2: 99, etco2: 35   },
              { systolic: 124, diastolic: 75,  heartRate: 70, spO2: 99, etco2: 35   },
              { systolic: 122, diastolic: 74,  heartRate: 70, spO2: 98, etco2: 36   },
              { systolic: 120, diastolic: 74,  heartRate: 72, spO2: 99, etco2: 36   },
              { systolic: 118, diastolic: 73,  heartRate: 72, spO2: 99, etco2: 35   },
            ],
            drugs: [
              { name: "Propofol",     dose: 150, unit: "mg",  colIdx: 0  },
              { name: "Succinylcholine", dose: 100, unit: "mg", colIdx: 0 },
              { name: "Fentanyl",     dose: 100, unit: "mcg", colIdx: 0  },
              { name: "Fentanyl",     dose: 50,  unit: "mcg", colIdx: 6  },
              { name: "Fentanyl",     dose: 50,  unit: "mcg", colIdx: 14 },
              { name: "Morphine",     dose: 5,   unit: "mg",  colIdx: 20 },
              { name: "Morphine",     dose: 5,   unit: "mg",  colIdx: 28 },
              { name: "Ephedrine",    dose: 15,  unit: "mg",  colIdx: 4  },
              { name: "Ephedrine",    dose: 15,  unit: "mg",  colIdx: 5  },
              { name: "Atropine",     dose: 0.5, unit: "mg",  colIdx: 4  },
              { name: "Ondansetron",  dose: 4,   unit: "mg",  colIdx: 30 },
              { name: "Dexamethasone",dose: 8,   unit: "mg",  colIdx: 2  },
              { name: "Neostigmine",  dose: 2.5, unit: "mg",  colIdx: 34 },
              { name: "Glycopyrrolate",dose: 0.5,unit: "mg",  colIdx: 34 },
            ],
            agents: [
              { name: "Sevoflurane 1.5–2%", startCol: 1, endCol: 34 },
            ],
            infusions: [
              { name: "Propofol", rate: 4, unit: "mg/kg/h", startCol: 0, endCol: 0 },
            ],
            fluids: [
              { name: "NaCl 0.9%",    volume: 1000, startCol: 0,  endCol: 18 },
              { name: "Ringer Lac.",  volume: 500,  startCol: 18, endCol: 30 },
              { name: "Gelofusine",   volume: 500,  startCol: 10, endCol: 22 },
            ],
          },
        },
      },
      postop: {
        create: {
          aldreteActivity:      2,
          aldreteRespiration:   2,
          aldreteCirculation:   2,
          aldreteConsciousness: 2,
          aldreteSpO2:          2,
          aldreteTotal:         10,
          painScoreNRS:         3,
          ponv:                 false,
          temperatureCelsius:   36.4,
          recoveryBpSystolic:   124,
          recoveryBpDiastolic:  76,
          recoveryHeartRate:    72,
          recoverySpO2:         98,
          disposition:          "WARD",
          dispositionNotes:     "Stable, tolerating oral fluids. Epidural infusion continued.",
          handoverItems: [
            "PAIN_MANAGEMENT", "NAUSEA_VOMITING", "FLUID_BALANCE",
            "WOUND_CARE", "MOBILITY", "DVT_PROPHYLAXIS",
          ],
        },
      },
    },
  })

  return NextResponse.json({ id: caseRecord.id })
}
