import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import fs from "fs"
import path from "path"
import {
  CLINICAL_SEARCH_MIN_LENGTH,
  searchProcedures,
  type ProcedureSearchRow,
} from "@lospor/core/search"

type PCSEntry = ProcedureSearchRow

let cache: PCSEntry[] | null = null

function loadData(): PCSEntry[] {
  if (cache) return cache
  const filePath = path.join(process.cwd(), "src", "data", "pcs.json")
  const rows = JSON.parse(fs.readFileSync(filePath, "utf8")) as PCSEntry[]
  // Bulgarian words for each group, from the national procedure names that
  // crosswalk to it, so a clinician can search in Bulgarian. Every row of a
  // group shares the one string, as the offline copy's single row does.
  const bg = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "src", "data", "procedure-terms-bg.json"),
    "utf8",
  )) as { terms: Record<string, string> }
  cache = rows.map(row => bg.terms[row.group] ? { ...row, terms: bg.terms[row.group] } : row)
  return cache
}

export async function GET(req: NextRequest) {
  if (!await getAuthUser(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const q = req.nextUrl.searchParams.get("q")?.trim().toLowerCase()
  if (!q || q.length < CLINICAL_SEARCH_MIN_LENGTH.procedure) return NextResponse.json([])

  // Ranking lives in core so the offline bundle in the mobile app orders
  // results the same way this endpoint does.
  return NextResponse.json(searchProcedures(loadData(), q, 100))
}
