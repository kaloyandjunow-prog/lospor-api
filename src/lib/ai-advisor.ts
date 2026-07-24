export const SYSTEM_PROMPT = `You are a board-certified anesthesiologist reviewing pre-operative clinical data and producing a structured summary for a fellow anaesthesiologist. This output is informational only — it does not constitute clinical advice, replace clinical judgement, or fulfill any regulatory function. The responsible anaesthesiologist retains full clinical responsibility. You receive structured patient data and produce a concise clinical summary. Use correct medical terminology, be direct, and do not over-explain basics.

Your analysis must cover EXACTLY these sections in order, using these exact headers:

## ASA Physical Status
State the recommended ASA class (I–V with E suffix if emergency) and give 2–3 bullet points justifying the classification based on the specific data provided. If the user-selected ASA differs from your recommendation, note the discrepancy.

## Anaesthesia Technique
Recommend the preferred technique(s) (GA, regional — specify neuraxial vs. peripheral nerve block, combined, or sedation). Give brief rationale. Note contraindications or cautions specific to this patient. If regional is preferred or feasible, name the specific block or neuraxial technique appropriate for the surgery.

## Airway Management
Classify the anticipated airway (anticipated difficult/easy/cannot rule out difficult). Summarise the risk factors present. Recommend the primary airway strategy (RSI, awake fibreoptic, video laryngoscopy, standard DL + ETT, SGA, etc.) and a backup plan. Note specific equipment or preparation needed.

## Pre-operative Preparation
List only the relevant, patient-specific preparations — investigations, optimisation targets, medications to hold or continue, blood product orders, special equipment. Do not list generic standard protocols that apply to every patient.

## Intraoperative Considerations
Highlight 3–5 specific intraoperative risks or management points for this patient (not generic monitoring that every anaesthetic includes). Include positioning, haemodynamic targets, fluid strategy, PONV risk, temperature management if relevant.

## Drug and Allergy Considerations
Review known medications and allergies. Note interactions, drugs to avoid, dose adjustments. If latex allergy is present, emphasise latex-free environment. If no relevant issues, state "No specific drug concerns identified."

Tone: precise, colleague-to-colleague. Format: markdown with the section headers above. No preamble, no closing pleasantries. If data is missing that would materially change your recommendation, note the specific gap in the relevant section rather than refusing to advise.`

// GDPR: builds patient summary from structured DB fields ONLY.
// The following free-text fields are intentionally excluded:
//   difficultAirwayNotes, familyAnesthesiaDetails, teamNotes, notes,
//   allergyDetails (free-text), complications, airwayNotes
type Tag = { label?: string }
export function buildPatientSummary(data: Record<string, unknown>): string {
  const lines: string[] = []

  const demo: string[] = []
  if (data.ageYears != null) demo.push(`Age: ${data.ageYears} years`)
  if (data.sex) demo.push(`Sex: ${data.sex}`)
  if (data.heightCm) demo.push(`Height: ${data.heightCm} cm`)
  if (data.weightKg) demo.push(`Weight: ${data.weightKg} kg`)
  if (data.heightCm && data.weightKg) {
    const bmi = Number(data.weightKg) / ((Number(data.heightCm) / 100) ** 2)
    demo.push(`BMI: ${bmi.toFixed(1)}`)
    if (bmi >= 35) demo.push(`(Class ${bmi >= 40 ? "III" : "II"} obesity)`)
  }
  if (data.bloodType) demo.push(`Blood type: ${data.bloodType}${data.rhFactor === "NEGATIVE" ? "−" : data.rhFactor === "POSITIVE" ? "+" : ""}`)
  if (demo.length) lines.push("**Demographics:** " + demo.join(", "))

  const diagnoses = Array.isArray(data.diagnoses) ? data.diagnoses as Tag[] : []
  const procedures = Array.isArray(data.procedures) ? data.procedures as Tag[] : []
  const comorbidities = Array.isArray(data.comorbidities) ? data.comorbidities as Tag[] : []
  const currentMedications = Array.isArray(data.currentMedications) ? data.currentMedications as Tag[] : []

  const surgery: string[] = []
  if (diagnoses.length) surgery.push(`Diagnoses: ${diagnoses.map(t => t.label).join("; ")}`)
  if (procedures.length) surgery.push(`Planned procedure: ${procedures.map(t => t.label).join("; ")}`)
  if (data.emergencySurgery) surgery.push("**EMERGENCY SURGERY**")
  if (data.highRiskSurgery) surgery.push("High-risk surgery")
  if (surgery.length) lines.push("\n**Surgical:** " + surgery.join(" | "))

  if (comorbidities.length)
    lines.push("\n**Comorbidities:** " + comorbidities.map(t => t.label).join("; "))

  if (data.asaScore) {
    const label = (data.emergencySurgery && data.asaScore !== "VI") ? `${data.asaScore}E` : data.asaScore
    lines.push(`\n**ASA score (clinician-assigned):** ${label}`)
  }

  const safety: string[] = []
  if (data.allergies) safety.push(`Allergies: ${Array.isArray(data.allergyDetails) ? (data.allergyDetails as Tag[]).map(t => t.label).join(", ") : "unspecified"}`)
  if (data.latexAllergy) safety.push("LATEX ALLERGY")
  if (currentMedications.length) safety.push(`Current medications: ${currentMedications.map(t => t.label).join(", ")}`)
  if (data.familyAnesthesiaProblems) safety.push("Family anaesthesia problems: yes (details withheld)")
  if (data.dentalProsthetics) safety.push("Dental prosthetics present")
  if (data.looseTeeth) safety.push("Loose teeth")
  if (data.smoking) safety.push("Smoker")
  if (data.substanceAbuse) safety.push("Substance use")
  if (safety.length) lines.push("\n**Safety flags:** " + safety.join(" | "))

  const vitals: string[] = []
  if (data.bpSystolic && data.bpDiastolic) vitals.push(`BP ${data.bpSystolic}/${data.bpDiastolic} mmHg`)
  if (data.heartRate) vitals.push(`HR ${data.heartRate} bpm`)
  if (data.heartArrhythmia) vitals.push("arrhythmia present")
  if (data.spO2) vitals.push(`SpO₂ ${data.spO2}%`)
  if (data.temperature) vitals.push(`Temp ${data.temperature}°C`)
  if (data.respiratoryRate) vitals.push(`RR ${data.respiratoryRate}/min`)
  if (vitals.length) lines.push("\n**Pre-op vitals:** " + vitals.join(", "))

  const airway: string[] = []
  if (data.mallampati) airway.push(`Mallampati ${data.mallampati}`)
  if (data.mouthOpeningCm) airway.push(`Mouth opening ${data.mouthOpeningCm} cm`)
  if (data.thyromental) airway.push(`Thyromental ${data.thyromental} cm`)
  if (data.neckMobility) airway.push(`Neck mobility: ${String(data.neckMobility).toLowerCase()}`)
  if (data.upperLipBiteTest) airway.push(`Upper lip bite test: ${String(data.upperLipBiteTest).replace("CLASS_", "class ")}`)
  if (data.retrognathia) airway.push("retrognathia")
  if (data.prominentIncisors) airway.push("prominent incisors")
  if (data.facialHair) airway.push("facial hair")
  if (data.cormackLehane) airway.push(`Previous Cormack-Lehane grade ${data.cormackLehane}`)
  if (data.difficultAirwayHistory) airway.push("Difficult airway history: yes (details withheld)")
  if (airway.length) lines.push("\n**Airway assessment:** " + airway.join("; "))
  else lines.push("\n**Airway assessment:** Not performed / not recorded")

  const scores: string[] = []
  if (data.rcriScore != null)   scores.push(`RCRI ${data.rcriScore}`)
  if (data.apfelScore != null)  scores.push(`Apfel ${data.apfelScore}`)
  if (data.stopBangScore != null) scores.push(`STOP-BANG ${data.stopBangScore}`)
  if (scores.length) lines.push("\n**Risk scores:** " + scores.join(", "))

  return lines.join("\n")
}
