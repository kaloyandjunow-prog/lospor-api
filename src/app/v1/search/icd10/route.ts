import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import {
  CLINICAL_SEARCH_MIN_LENGTH,
  ICD10_CODE_CONFIDENCE,
  ICD10_CODE_TAKE,
  ICD10_LABEL_PREFIX_MAX_LENGTH,
  ICD10_LABEL_TAKE,
  isIcd10CodeLikeQuery,
  mergeIcd10Results,
  type Icd10SearchRow,
} from "@lospor/core/search"

export async function GET(req: NextRequest) {
  if (!await getAuthUser(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const q = req.nextUrl.searchParams.get("q")?.trim()
  const locale = req.nextUrl.searchParams.get("locale") ?? "en"
  if (!q || q.length < CLINICAL_SEARCH_MIN_LENGTH.icd10) return NextResponse.json([])

  const useBg = locale === "bg"
  const term = q.toLowerCase()
  const codeLike = isIcd10CodeLikeQuery(q)

  // Every query orders by code. Without an explicit order Postgres may return
  // any rows it likes for a `take`, which made the result set unreproducible —
  // and the offline vocabulary, which can only sort by code, could not be shown
  // to agree with it. Deterministic here means testable against the bundle.
  const byCode = await prisma.icd10Code.findMany({
    where: { code: { startsWith: q.toUpperCase() } },
    orderBy: { code: "asc" },
    take: ICD10_CODE_TAKE,
  })

  if (codeLike || byCode.length >= ICD10_CODE_CONFIDENCE) {
    return NextResponse.json(mergeIcd10Results([byCode], useBg))
  }

  const labelFilter =
    q.length < ICD10_LABEL_PREFIX_MAX_LENGTH
      ? { startsWith: term, mode: "insensitive" as const }
      : { contains: term, mode: "insensitive" as const }

  const [byBgLabel, byEnLabel, bySynonym] = await Promise.all([
    useBg
      ? prisma.icd10Code.findMany({
          where: { labelBg: labelFilter },
          orderBy: { code: "asc" },
          take: ICD10_LABEL_TAKE,
        })
      : Promise.resolve([] as Icd10SearchRow[]),
    prisma.icd10Code.findMany({
      where: { labelEn: labelFilter },
      orderBy: { code: "asc" },
      take: ICD10_LABEL_TAKE,
    }),
    prisma.icd10Synonym.findMany({
      where: { synonym: labelFilter },
      include: { icd10: true },
      orderBy: { icd10Code: "asc" },
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
