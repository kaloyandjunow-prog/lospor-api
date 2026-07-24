import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import fs from "fs"
import path from "path"
import { CLINICAL_SEARCH_MIN_LENGTH } from "@lospor/core/search"

type PCSEntry = { code: string; description: string; group: string; domain: string }

let cache: PCSEntry[] | null = null

function loadData(): PCSEntry[] {
  if (cache) return cache
  const filePath = path.join(process.cwd(), "src", "data", "pcs.json")
  cache = JSON.parse(fs.readFileSync(filePath, "utf8")) as PCSEntry[]
  return cache
}

const COMMON_GROUPS = new Set([
  "Cholecystectomy", "Appendectomy", "Colectomy", "Gastrectomy",
  "Hernia repair procedures", "Mastectomy", "Thyroidectomy", "Splenectomy",
  "Hip replacement procedures", "Knee replacement procedures",
  "Coronary artery bypass graft (CABG)", "Cardiac valve procedures",
  "Caesarean section", "Hysterectomy",
  "Hip fracture repair", "Knee arthroscopy procedures",
  "Craniotomy procedures", "Laminectomy procedures", "Discectomy",
  "Nephrectomy", "Prostatectomy", "Cystectomy",
  "Lung resection procedures", "Lobectomy",
  "Aortic aneurysm repair", "Carotid endarterectomy",
  "Tonsillectomy and/or adenoidectomy", "Cataract removal",
  "Amputation of lower extremity", "Skin graft procedures",
])

export async function GET(req: NextRequest) {
  if (!await getAuthUser(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const q = req.nextUrl.searchParams.get("q")?.trim().toLowerCase()
  if (!q || q.length < CLINICAL_SEARCH_MIN_LENGTH.procedure) return NextResponse.json([])

  const data = loadData()
  const bestPerGroup = new Map<string, { entry: PCSEntry; score: number }>()

  for (const entry of data) {
    const descLower  = entry.description.toLowerCase()
    const groupLower = entry.group.toLowerCase()
    const domainLower = entry.domain.toLowerCase()
    const codeLower  = entry.code.toLowerCase()

    if (!descLower.includes(q) && !groupLower.includes(q) && !domainLower.includes(q) && !codeLower.startsWith(q)) continue

    const isCommon   = COMMON_GROUPS.has(entry.group) ? 2000 : 0
    const groupMatch = groupLower.includes(q) ? 500 : 0
    const codeMatch  = codeLower.startsWith(q) ? 200 : 0
    const startBonus = groupLower.startsWith(q) ? 100 : 0
    const score      = isCommon + groupMatch + codeMatch + startBonus

    const key      = entry.group.toLowerCase().trim()
    const existing = bestPerGroup.get(key)
    if (!existing || score > existing.score) bestPerGroup.set(key, { entry, score })
  }

  const results = Array.from(bestPerGroup.values())
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry)

  return NextResponse.json(results.slice(0, 100))
}
