import { readdir, readFile } from "node:fs/promises"
import { basename, extname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..")
// `scripts` is included because it is type-checked by `next build`: a broken
// import there fails the deployment exactly as one in `src` would.
const sourceRoots = ["src", "scripts"]
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"])
const ignoredDirectories = new Set(["generated", "node_modules", ".next", "dist", "coverage"])

const forbiddenArrayDeclarations = [
  "DRUG_CATS",
  "INF_DRUGS",
  "FLUID_LIST",
  "VOLATILE_AGENTS",
]
const forbiddenDeclarations = [
  "TECHNIQUE_FAVORITES",
  "HANDOVER_CODE_ALIASES",
  "HANDOVER_GROUPS_EN",
  "HANDOVER_GROUPS_BG",
  "LAB_CATALOG",
  "ICD10_BODY_SYSTEMS",
  "rcriRiskBand",
  "apfelRiskBand",
  "stopBangRiskBand",
]

const rules = [
  {
    description: "legacy client-owned option-library import",
    pattern: /(?:from\s+|require\()\s*["'][^"']*(?:data\/option-library|option-library-fallback)/,
  },
  {
    description: "hardcoded clinical option array",
    pattern: new RegExp(
      String.raw`\b(?:const|let|var)\s+(?:${forbiddenArrayDeclarations.join("|")})\s*=\s*\[`,
    ),
  },
  {
    description: "shared clinical declaration",
    pattern: new RegExp(
      String.raw`\b(?:const|let|var)\s+(?:${forbiddenDeclarations.join("|")})\b`,
    ),
  },
  {
    description: "shared clinical threshold function",
    pattern: /\bfunction\s+(?:rcriRiskBand|apfelRiskBand|stopBangRiskBand)\b/,
  },
  {
    description: "hardcoded five-minute timetable column arithmetic",
    pattern: /\b(?:col|colIdx|startCol|endCol)\s*\*\s*5\b|\bINTERVAL\s*=\s*5\b/,
  },
  {
    description: "client framework code does not belong in lospor-api",
    pattern: /(?:from\s+["'](?:react-native|expo(?:\/[^"']*)?)["']|AsyncStorage|indexedDB|localStorage)/,
  },
  {
    // Reaching into a sibling repository by relative path resolves only on a
    // machine where the repos happen to sit side by side. CI and Vercel check
    // out this repository alone, so it fails there and nowhere else -- a build
    // break that no amount of local verification can surface. Import the
    // published package instead: "@lospor/core/clinical-rules".
    description: "relative import escaping the repository (use @lospor/core/...)",
    pattern: /(?:from\s+|require\()\s*["'](?:\.\.\/)+lospor-(?:core|app|mobile|browser|docs)\//,
  },
]

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else if (extensions.has(extname(entry.name))) files.push(path)
  }
  return files
}

// This file states every forbidden pattern literally, so scanning `scripts`
// makes it match itself. Skip it rather than contort the patterns.
const selfPath = fileURLToPath(import.meta.url)

const violations = []
for (const sourceRoot of sourceRoots) {
  const files = await filesUnder(join(root, sourceRoot))
  for (const file of files) {
    if (file === selfPath) continue
    if (basename(file) === "option-library-fallback.json") {
      violations.push(`${relative(root, file)}: copied fallback catalog`)
      continue
    }
    const source = await readFile(file, "utf8")
    for (const rule of rules) {
      const match = rule.pattern.exec(source)
      if (!match) continue
      const line = source.slice(0, match.index).split(/\r?\n/).length
      violations.push(`${relative(root, file)}:${line}: ${rule.description}`)
    }
  }
}

if (violations.length > 0) {
  console.error("Shared Core boundary violations:")
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log("Shared Core boundaries OK")
}
