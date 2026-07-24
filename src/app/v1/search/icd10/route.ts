import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { isIcd10CodeLikeQuery, mergeIcd10Results, type Icd10SearchRow } from "@/lib/icd10-search"
import { CLINICAL_SEARCH_MIN_LENGTH } from "@lospor/core/search"

export async function GET(req: NextRequest) {
  if (!await getAuthUser(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const q = req.nextUrl.searchParams.get("q")?.trim()
  const locale = req.nextUrl.searchParams.get("locale") ?? "en"
  if (!q || q.length < CLINICAL_SEARCH_MIN_LENGTH.icd10) return NextResponse.json([])

  const useBg = locale === "bg"
  const term = q.toLowerCase()
  const codeLike = isIcd10CodeLikeQuery(q)

  const byCode = await prisma.icd10Code.findMany({
    where: { code: { startsWith: q.toUpperCase() } },
    take: 20,
  })

  if (codeLike || byCode.length >= 8) {
    return NextResponse.json(mergeIcd10Results([byCode], useBg))
  }

  const labelFilter =
    q.length < 4
      ? { startsWith: term, mode: "insensitive" as const }
      : { contains: term, mode: "insensitive" as const }

  const [byBgLabel, byEnLabel, bySynonym] = await Promise.all([
    useBg
      ? prisma.icd10Code.findMany({
          where: { labelBg: labelFilter },
          take: 15,
        })
      : Promise.resolve([] as Icd10SearchRow[]),
    prisma.icd10Code.findMany({
      where: { labelEn: labelFilter },
      take: 15,
    }),
    prisma.icd10Synonym.findMany({
      where: { synonym: labelFilter },
      include: { icd10: true },
      take: 10,
    }),
  ])

  return NextResponse.json(mergeIcd10Results([
    byBgLabel,
    byCode,
    byEnLabel,
    bySynonym.map((row) => row.icd10),
  ], useBg))
}
