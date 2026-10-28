import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { LibraryCategory } from "@/generated/prisma/client"
import { customColorFor, DRUG_COLOR_CATEGORIES, readDrugColors } from "@/lib/drug-colors"

// Master library endpoint — both web and mobile read every selectable
// pill-button option (position, technique, vascular access, airway
// management, monitoring, premedication/intraop drugs, infusions,
// inhalational agents, fluids, clinical events) from here instead of each
// app hardcoding its own copy. Lists are small/bounded, so this returns the
// full active set per category rather than a type-ahead search.
export async function GET(req: NextRequest, { params }: { params: Promise<{ category: string }> }) {
  if (!await getAuthUser(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { category } = await params
  const upper = category.toUpperCase()
  if (!Object.values(LibraryCategory).includes(upper as LibraryCategory)) {
    return NextResponse.json({ error: "Unknown category" }, { status: 400 })
  }

  const rows = await prisma.optionLibrary.findMany({
    where: { category: upper as LibraryCategory, active: true },
    orderBy: [{ sortOrder: "asc" }],
    include: { drug: { select: { atcCode: true, inn: true } } },
  })
  // The hospital's own drug colours (10.0.0), resolved here so web and phone
  // draw one colour per drug without each working it out.
  const drugColors = (DRUG_COLOR_CATEGORIES as readonly string[]).includes(upper) ? await readDrugColors(prisma) : null

  return NextResponse.json(rows.map(r => ({
    id: r.id,
    value: r.value,
    label: r.labelEn,
    labelBg: r.labelBg,
    group: r.group,
    parentId: r.parentId,
    color: r.color,
    ...(drugColors ? customColorFor(drugColors, r) : {}),
    description: r.description,
    drugId: r.drugId,
    atcCode: r.drug?.atcCode ?? null,
    inn: r.drug?.inn ?? null,
    metadata: r.metadata,
  })))
}
