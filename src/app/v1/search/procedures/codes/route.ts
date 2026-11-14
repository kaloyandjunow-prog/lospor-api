import { NextRequest, NextResponse } from "next/server"
import { filterProcedureCodes } from "@lospor/core/procedure-codes"
import { getAuthUser } from "@/lib/mobile-auth"
import { procedureRowsFromData } from "@/lib/procedure-data"

/** Enough to scroll; a larger group asks the clinician to type a word first. */
const CODE_LIMIT = 200

/**
 * The exact operations inside one procedure group, narrowed by `q`.
 *
 * The second, optional step after choosing a group: the clinician picks the
 * ICD-10-PCS operation actually planned, which is also its research code.
 * `total` counts every match, so a client can say how many more a word would
 * narrow down. `suggested` (comma-separated codes, from a hospital code's
 * crosswalk) puts those operations first, marked.
 */
export async function GET(req: NextRequest) {
  if (!await getAuthUser(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const group = req.nextUrl.searchParams.get("group")?.trim()
  if (!group) return NextResponse.json({ error: "group is required" }, { status: 400 })
  const q = req.nextUrl.searchParams.get("q")?.trim().slice(0, 200) ?? ""
  const suggested = (req.nextUrl.searchParams.get("suggested") ?? "").split(",").map(code => code.trim()).filter(Boolean).slice(0, 50)

  const rows = procedureRowsFromData()
  const codes = filterProcedureCodes(rows, group, q, suggested)
  // A group can span ICD-10-PCS sections, so each operation carries its own,
  // in both languages; the group's Bulgarian name rides along for the tag.
  const byCode = new Map(rows.map(row => [row.code, row]))
  const groupBg = codes.length ? byCode.get(codes[0].code)?.groupBg ?? null : null
  return NextResponse.json({
    group,
    ...(groupBg ? { groupBg } : {}),
    total: codes.length,
    codes: codes.slice(0, CODE_LIMIT).map(code => {
      const row = byCode.get(code.code)
      return { ...code, domain: row?.domain ?? null, ...(row?.domainBg ? { domainBg: row.domainBg } : {}) }
    }),
  })
}
