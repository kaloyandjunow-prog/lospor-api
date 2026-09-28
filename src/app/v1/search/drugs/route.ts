import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { CLINICAL_SEARCH_MIN_LENGTH } from "@lospor/core/search"
import { searchMedications } from "@lospor/core/medications"
import { medicationRows } from "@lospor/core/vocabulary/medications"

/**
 * Home medications and allergies, from Core's medication list (the national
 * register CL009 plus the products it lacks) -- the same list and the same
 * search the phone uses offline and Status maps codes to (9.13.3).
 *
 * It used to read the Drug table first and fall back to a separate file, two
 * lists that could answer the same query differently, and on an appliance
 * whose terminology import had not run, only the file answered anyway.
 */
export async function GET(req: NextRequest) {
  if (!await getAuthUser(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? ""
  if (q.length < CLINICAL_SEARCH_MIN_LENGTH.medication) return NextResponse.json([])

  // The web form reads atcCode, the older clients atc: both are sent.
  return NextResponse.json(searchMedications(medicationRows(), q).map(row => ({
    id: row.id,
    name: row.name,
    inn: row.inn,
    form: row.form,
    strength: row.strength,
    atc: row.atc,
    atcCode: row.atc,
    ...(row.nhisCode ? { nhisCode: row.nhisCode } : {}),
  })))
}
