import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { procedureRowsFromData } from "@/lib/procedure-data"
import {
  CLINICAL_SEARCH_MIN_LENGTH,
  searchProcedures,
} from "@lospor/core/search"

export async function GET(req: NextRequest) {
  if (!await getAuthUser(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const q = req.nextUrl.searchParams.get("q")?.trim().toLowerCase()
  if (!q || q.length < CLINICAL_SEARCH_MIN_LENGTH.procedure) return NextResponse.json([])

  // Ranking lives in core so the offline bundle in the mobile app orders
  // results the same way this endpoint does.
  return NextResponse.json(searchProcedures(procedureRowsFromData(), q, 100))
}
