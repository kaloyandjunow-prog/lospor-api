/**
 * Merge an externally extracted NHIS CL011 snapshot into Core's offline ICD-10
 * bundle and produce a reviewable label-change report.
 *
 * The official workbook remains outside the public repositories. Run the
 * zero-dependency extractor in hisbg-nomenclatures first, then pass its
 * normalized CL011.json here:
 *
 *   npx tsx scripts/merge-nhis-icd10.mts \
 *     --source ../../hisbg-nomenclatures/out/nhis/CL011.json \
 *     --report-dir ../../hisbg-nomenclatures/out/import \
 *     --write
 *
 * Without --write, reports are produced but the Core bundle is not changed.
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

type CoreRow = [code: string, labelEn: string, labelBg: string]
type NhisRow = {
  key: string
  fields?: Record<string, unknown>
  retired?: boolean
  since?: string
  validUntil?: string
}
type NhisSnapshot = {
  list: string
  sourceVersion: string
  sourceSha256?: string
  rows: NhisRow[]
}

const args = process.argv.slice(2)
function option(name: string): string | undefined {
  const equals = args.find(value => value.startsWith(`${name}=`))
  if (equals) return equals.slice(name.length + 1)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const sourceArg = option("--source")
if (!sourceArg) throw new Error("Missing required --source <normalized CL011.json>")

const sourcePath = path.resolve(sourceArg)
const reportDir = path.resolve(option("--report-dir") ?? path.join(path.dirname(sourcePath), "..", "import"))
const coreRepository = path.resolve("../lospor-core")
const corePath = path.join(coreRepository, "src", "vocabulary", "icd10.ts")
const indexPath = path.join(coreRepository, "src", "vocabulary", "index.ts")
const baselineRef = option("--baseline-ref")
const writeBundle = args.includes("--write")
const ICD_CODE = /^[A-Z][0-9]{2}(?:\.[0-9A-Z]{1,2})?$/

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : ""
}

function normalizedLabel(value: string): string {
  return value.normalize("NFKC").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()
}

/** Repair UTF-8 bytes that the source workbook exposed as Latin-1 text. */
function repairUtf8Mojibake(value: string): string {
  if (!/[ÃÂ]/.test(value)) return value
  const repaired = Buffer.from(value, "latin1").toString("utf8")
  if (repaired.includes("\uFFFD")) {
    throw new Error(`Cannot safely repair encoding-damaged label: ${JSON.stringify(value)}`)
  }
  return repaired
}

// Three eponyms in Bulgarian labels carry a single Windows-1252 character
// decoded as Cyrillic. They cannot be repaired by the UTF-8 pass above because
// the rest of each label is valid Cyrillic text.
const KNOWN_LABEL_CORRECTIONS = new Map([
  ["M35.0|bg", "Синдром на Sjögren"],
  ["M35.2|bg", "Синдром на Behçet"],
  ["M93.1|bg", "Болест на Kienböck при възрастни"],
  ["S06.51|en", "Traumatic subdural hemorrhage, with open intracranial trauma"],
  ["S06.51|bg", "Травматичен субдурален кръвоизлив, с открита вътречерепна травма"],
])

function authoritativeLabel(code: string, locale: "en" | "bg", value: unknown): string {
  const corrected = KNOWN_LABEL_CORRECTIONS.get(`${code}|${locale}`)
    ?? repairUtf8Mojibake(text(value))
  return corrected
}

function csvCell(value: unknown): string {
  const rendered = String(value ?? "")
  return /[",\r\n]/.test(rendered) ? `"${rendered.replace(/"/g, '""')}"` : rendered
}

function parseCoreRows(source: string): CoreRow[] {
  const block = source.match(/const ROWS: \[string, string, string\]\[\] = \[\r?\n([\s\S]*?)\r?\n\]/)?.[1]
  if (!block) throw new Error(`Cannot find generated ICD tuple block in ${corePath}`)
  return block.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const json = line.trim().replace(/,$/, "")
    const row = JSON.parse(json) as unknown
    if (!Array.isArray(row) || row.length !== 3 || row.some(value => typeof value !== "string")) {
      throw new Error(`Invalid Core ICD tuple at generated row ${index + 1}`)
    }
    return row as CoreRow
  })
}

function labelVerdict(current: string, nhis: string): string {
  const left = normalizedLabel(current)
  const right = normalizedLabel(nhis)
  if (!left || !right) return "missing"
  if (left === right) return "exact"
  if (left.toLocaleLowerCase("bg-BG") === right.toLocaleLowerCase("bg-BG")) return "case-only"
  return "different"
}

const snapshot = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as NhisSnapshot
if (snapshot.list !== "CL011" || !snapshot.sourceVersion || !Array.isArray(snapshot.rows)) {
  throw new Error("Source is not a normalized NHIS CL011 snapshot")
}

const baselineSource = baselineRef
  ? execFileSync("git", ["-C", coreRepository, "show", `${baselineRef}:src/vocabulary/icd10.ts`], {
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
    })
  : fs.readFileSync(corePath, "utf8")
const originalRows = parseCoreRows(baselineSource)
const merged = new Map(originalRows.map(row => [row[0], [...row] as CoreRow]))
const seenNhis = new Set<string>()
const added: Array<{ code: string; labelEn: string; labelBg: string; since: string }> = []
const comparisons: Array<{
  code: string
  losporLabelEn: string
  nhisLabelEn: string
  englishVerdict: string
  losporLabelBg: string
  nhisLabelBg: string
  bulgarianVerdict: string
}> = []

for (const row of snapshot.rows) {
  if (row.retired) continue
  const code = text(row.key).toUpperCase()
  if (!ICD_CODE.test(code)) throw new Error(`Invalid active CL011 code: ${JSON.stringify(row.key)}`)
  if (seenNhis.has(code)) throw new Error(`Duplicate active CL011 code: ${code}`)
  seenNhis.add(code)

  const labelEn = authoritativeLabel(
    code,
    "en",
    row.fields?.["Display value EN"] || row.fields?.["Description EN"],
  )
  const labelBg = authoritativeLabel(
    code,
    "bg",
    row.fields?.["Display value BG"] || row.fields?.["Description BG"],
  )
  if (!labelEn || !labelBg) throw new Error(`Active CL011 code has incomplete display labels: ${code}`)

  const current = merged.get(code)
  if (current) {
    comparisons.push({
      code,
      losporLabelEn: current[1],
      nhisLabelEn: labelEn,
      englishVerdict: labelVerdict(current[1], labelEn),
      losporLabelBg: current[2],
      nhisLabelBg: labelBg,
      bulgarianVerdict: labelVerdict(current[2], labelBg),
    })
    // CL011 is the Bulgarian deployment authority for exact code identities.
    merged.set(code, [code, labelEn, labelBg])
  } else {
    merged.set(code, [code, labelEn, labelBg])
    added.push({ code, labelEn, labelBg, since: text(row.since) })
  }
}

const mergedRows = [...merged.values()].sort((a, b) => a[0].localeCompare(b[0], "en"))
const countsBy = (field: "englishVerdict" | "bulgarianVerdict") => Object.fromEntries(
  [...new Set(comparisons.map(row => row[field]))].sort().map(verdict => [
    verdict,
    comparisons.filter(row => row[field] === verdict).length,
  ]),
)

const report = {
  generatedAt: new Date().toISOString(),
  source: {
    list: snapshot.list,
    version: snapshot.sourceVersion,
    workbookSha256: snapshot.sourceSha256 ?? null,
    normalizedJson: sourcePath,
    baselineRef: baselineRef ?? null,
  },
  policy: {
    activeRowsOnly: true,
    codeIdentity: "Exact trimmed uppercase code; Bulgarian extensions are not collapsed to a parent",
    sharedCodeLabels: "NHIS Display value EN/BG override LOSPOR labels for exact code identities",
    losporOnlyRows: "Preserved",
  },
  counts: {
    originalRows: originalRows.length,
    activeNhisCodes: seenNhis.size,
    sharedCodes: comparisons.length,
    addedCodes: added.length,
    mergedRows: mergedRows.length,
    englishLabels: countsBy("englishVerdict"),
    bulgarianLabels: countsBy("bulgarianVerdict"),
  },
  labelComparisons: comparisons,
  addedCodes: added,
}

fs.mkdirSync(reportDir, { recursive: true })
fs.writeFileSync(path.join(reportDir, "nhis-icd10-import-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")
const csvHeader = ["code", "lospor_label_en", "nhis_label_en", "english_verdict", "lospor_label_bg", "nhis_label_bg", "bulgarian_verdict"]
const csvRows = comparisons.map(row => [row.code, row.losporLabelEn, row.nhisLabelEn, row.englishVerdict, row.losporLabelBg, row.nhisLabelBg, row.bulgarianVerdict])
fs.writeFileSync(
  path.join(reportDir, "nhis-icd10-label-review.csv"),
  `${[csvHeader, ...csvRows].map(row => row.map(csvCell).join(",")).join("\n")}\n`,
  "utf8",
)

const changedEn = comparisons.filter(row => row.englishVerdict !== "exact")
const changedBg = comparisons.filter(row => row.bulgarianVerdict !== "exact")
const summary = `# NHIS CL011 ICD-10 merge\n\n` +
  `Source: CL011 ${snapshot.sourceVersion}; workbook SHA-256 \`${snapshot.sourceSha256 ?? "not recorded"}\`.\n\n` +
  `- Original LOSPOR rows: ${originalRows.length.toLocaleString("en-US")}\n` +
  `- Active NHIS codes: ${seenNhis.size.toLocaleString("en-US")}\n` +
  `- Exact shared codes: ${comparisons.length.toLocaleString("en-US")}\n` +
  `- NHIS codes added: ${added.length.toLocaleString("en-US")}\n` +
  `- Final rows: ${mergedRows.length.toLocaleString("en-US")}\n` +
  `- Shared English labels not exactly equal: ${changedEn.length.toLocaleString("en-US")}\n` +
  `- Shared Bulgarian labels not exactly equal: ${changedBg.length.toLocaleString("en-US")}\n\n` +
  `For exact shared codes, NHIS Display value EN/BG is the resulting display label. Full before/after comparisons are in \`nhis-icd10-label-review.csv\`.\n`
fs.writeFileSync(path.join(reportDir, "nhis-icd10-import-summary.md"), summary, "utf8")

if (writeBundle) {
  const vocabularyVersion = "2026-09-13"
  const generated = `// GENERATED by lospor-api/scripts/merge-nhis-icd10.mts — do not edit.\n` +
    `// ${mergedRows.length} ICD-10 codes and navigation rows (EN + BG).\n` +
    `// NHIS CL011 ${snapshot.sourceVersion}; source workbook SHA-256: ${snapshot.sourceSha256 ?? "not recorded"}\n` +
    `// Vocabulary version: ${vocabularyVersion}\n\n` +
    `import type { Icd10SearchRow } from "../search"\n\n` +
    `/** Stored as tuples to reduce source and runtime object overhead. */\n` +
    `const ROWS: [string, string, string][] = [\n` +
    `${mergedRows.map(row => `  ${JSON.stringify(row)},`).join("\n")}\n]\n\n` +
    `let expanded: Icd10SearchRow[] | null = null\n\n` +
    `/** Expanded on first use — never at module load. */\n` +
    `export function icd10Rows(): Icd10SearchRow[] {\n` +
    `  if (!expanded) {\n` +
    `    expanded = ROWS.map(([code, labelEn, labelBg]) => ({\n` +
    `      code,\n` +
    `      labelEn,\n` +
    `      ...(labelBg ? { labelBg } : {}),\n` +
    `    }))\n` +
    `  }\n` +
    `  return expanded\n` +
    `}\n\n` +
    `export const ICD10_ROW_COUNT = ${mergedRows.length}\n`
  fs.writeFileSync(corePath, generated, "utf8")

  const indexSource = fs.readFileSync(indexPath, "utf8")
  if (!/export const VOCABULARY_VERSION = "[^"]+"/.test(indexSource)) {
    throw new Error(`Cannot find VOCABULARY_VERSION in ${indexPath}`)
  }
  fs.writeFileSync(
    indexPath,
    indexSource
      .replace(/\/\/ Vocabulary version: [^\r\n]+/, `// Vocabulary version: ${vocabularyVersion}`)
      .replace(/export const VOCABULARY_VERSION = "[^"]+"/, `export const VOCABULARY_VERSION = "${vocabularyVersion}"`),
    "utf8",
  )
}

console.log(JSON.stringify({ ...report.counts, writeBundle, reportDir }, null, 2))
