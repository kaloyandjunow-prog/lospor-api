import { NextRequest, NextResponse } from "next/server"
import { caseTheatreName } from "@lospor/core/operating-theatres"
import { operatingTheatresEnabled } from "@/lib/operating-theatres"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { caseReadWhereForUser } from "@/lib/access-control"
import { verifyPrintToken } from "@/lib/print-token"
import { preopDocuments } from "@/lib/preop/documents"
import { preopQuestionnaire } from "@/lib/preop/questionnaire"
import { defaultPreopProfileShape, readPreopProfiles, serializePreopProfiles } from "@/lib/preop/service"
import { serializeMedicationInstruction, serializePremedicationOrders, serializeWardOrder } from "@/lib/preop/sections"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const queryToken = req.nextUrl.searchParams.get("print_token")
  const tokenUserId = queryToken
    ? await verifyPrintToken(queryToken, id)
    : null

  let where
  if (tokenUserId) {
    where = { id }
  } else {
    const user = await getAuthUser(req)
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    where = caseReadWhereForUser(user, id)
  }

  const record = await prisma.case.findFirst({
    where,
    include: {
      preop: {
        include: {
          assessmentAnswers: { select: { state: true, optionKey: true, valueText: true, question: { select: { stableKey: true } } } },
          // The orders left for the ward print on the summary; a cancelled one was not left.
          wardOrders: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } },
          medicationInstructions: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } },
          premedicationOrders: { where: { status: "ACTIVE" }, orderBy: { ordinal: "asc" } },
        },
      },
      intraop: true,
      postop: true,
      institution: { select: { name: true, city: true } },
      operatingTheatre: { select: { name: true } },
      // The preop summary names who consulted and who has the case now.
      createdBy: { select: { name: true, title: true } },
      user: { select: { name: true, title: true } },
    },
  })
  if (!record) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  // The preop summary sheet prints in headless Chrome with only a print
  // token, so the switches and consent texts travel with the case.
  const { assessmentAnswers, wardOrders, medicationInstructions, premedicationOrders, ...preopColumns } = record.preop ?? { assessmentAnswers: [], wardOrders: [], medicationInstructions: [], premedicationOrders: [] }
  const preop = {
    ...preopColumns,
    preopWardOrders: wardOrders.map(serializeWardOrder),
    preopMedicationInstructions: medicationInstructions.map(serializeMedicationInstruction),
    preopPremedicationOrders: serializePremedicationOrders(premedicationOrders),
  }
  // The summary prints the questionnaire the form showed: this population's profile.
  const profiles = record.preop ? await readPreopProfiles(prisma) : null
  const profile = profiles ? serializePreopProfiles(profiles) : defaultPreopProfileShape()
  return NextResponse.json({
    ...record,
    // The operating theatre prints on the record (10.0.0): the name it kept.
    operatingTheatre: undefined,
    // Off, nothing prints unless the case kept a name from its start.
    theatreName: record.operatingTheatreName ?? (await operatingTheatresEnabled(prisma) ? caseTheatreName(record) : null),
    preop: record.preop ? preop : null,
    preopDocuments: await preopDocuments(prisma),
    preopQuestionnaire: preopQuestionnaire(record.preop, assessmentAnswers, profile, record.clinicalMode),
  })
}
