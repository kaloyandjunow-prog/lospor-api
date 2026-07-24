// Seed the LabLoinc table for the canonical 66-test lab library.
// Run: npx tsx scripts/seed-lab-loinc.ts
// Idempotent: upserts by canonical lab name.

import "dotenv/config"
import { PrismaClient, Prisma } from "../src/generated/prisma/client"
import { LAB_LIBRARY } from "../src/lib/labs"
import { PrismaPg } from "@prisma/adapter-pg"

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter } satisfies Prisma.PrismaClientOptions)

const LOINC_CODES: Record<string, string> = {
  "Haemoglobin (Hb)": "718-7",
  "Haematocrit (Hct)": "4544-3",
  "Erythrocytes (RBC)": "789-8",
  "Leucocytes (WBC)": "6690-2",
  "Platelets": "777-3",
  "MCV": "787-2",
  "MCH": "785-6",
  "MCHC": "786-4",
  "Neutrophils": "770-8",
  "Lymphocytes": "736-9",
  "Monocytes": "742-7",
  "Eosinophils": "713-8",
  "Reticulocytes": "415-0",
  "PT (Prothrombin time)": "5902-2",
  "INR": "6301-6",
  "aPTT": "3173-2",
  "Fibrinogen": "3255-7",
  "D-dimer": "48066-5",
  "Thrombin time (TT)": "3243-3",
  "Anti-Xa": "3179-9",
  "Sodium (Na⁺)": "2951-2",
  "Potassium (K⁺)": "2823-3",
  "Chloride (Cl⁻)": "2075-0",
  "Bicarbonate (HCO₃⁻)": "1963-8",
  "Calcium (Ca²⁺)": "17861-6",
  "Ionised Ca²⁺": "1994-3",
  "Magnesium (Mg²⁺)": "2601-3",
  "Phosphate": "2777-1",
  "Creatinine": "14682-9",
  "eGFR": "62238-1",
  "Urea (BUN)": "3094-0",
  "Glucose": "2345-7",
  "HbA1c": "4548-4",
  "Lactate": "2524-7",
  "Uric acid": "3084-1",
  "Total protein": "2885-2",
  "Albumin": "1751-7",
  "ALT (SGPT)": "1742-6",
  "AST (SGOT)": "1920-8",
  "ALP": "6768-6",
  "GGT": "2324-2",
  "Total bilirubin": "1975-2",
  "Direct bilirubin": "14631-6",
  "Total bile acids": "30239-8",
  "Troponin I (hs-cTnI)": "89579-7",
  "Troponin T (hs-cTnT)": "67151-1",
  "CK (Creatine kinase)": "2157-6",
  "CK-MB": "12187-7",
  "BNP": "42637-9",
  "NT-proBNP": "33762-6",
  "Myoglobin": "2154-3",
  "pH": "2744-1",
  "PaO₂": "2703-7",
  "PaCO₂": "2019-8",
  "HCO₃⁻ (ABG)": "1960-4",
  "Base excess (BE)": "1925-7",
  "SaO₂": "2708-6",
  "Lactate (ABG)": "32693-4",
  "TSH": "3016-3",
  "Free T4 (fT4)": "3024-7",
  "Free T3 (fT3)": "3051-0",
  "CRP": "1988-5",
  "ESR": "4537-7",
  "Ferritin": "2276-4",
  "Procalcitonin (PCT)": "75241-0",
  "IL-6": "26881-3",
}

async function main() {
  console.log(`Seeding ${LAB_LIBRARY.length} LabLoinc entries...`)
  let upserted = 0
  for (const lab of LAB_LIBRARY) {
    const loincCode = LOINC_CODES[lab.name]
    if (!loincCode) throw new Error(`Missing LOINC code for ${lab.name}`)
    await prisma.labLoinc.upsert({
      where: { name: lab.name },
      update: {
        loincCode,
        unitCanon: lab.unit,
        referenceLow: lab.refLow ?? null,
        referenceHigh: lab.refHigh ?? null,
      },
      create: {
        name: lab.name,
        loincCode,
        unitCanon: lab.unit,
        referenceLow: lab.refLow ?? null,
        referenceHigh: lab.refHigh ?? null,
      },
    })
    upserted++
  }
  console.log(`Done. ${upserted} rows upserted.`)
}

main().catch(console.error).finally(() => prisma.$disconnect())
