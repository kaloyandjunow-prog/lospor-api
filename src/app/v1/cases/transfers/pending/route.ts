import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { corsHeaders } from "@/lib/cors"

const CORS = (req: NextRequest) => corsHeaders(req, "GET, OPTIONS")
export async function OPTIONS(req: NextRequest) { return new NextResponse(null, { status: 204, headers: CORS(req) }) }

/**
 * Pending handovers, in either direction.
 *
 * `?direction=outgoing` lists what this person is waiting to hand over. Without
 * it there is no way to see that a handover was never answered, and no way to
 * reach the cancel action at all — a case offered to someone on annual leave
 * would sit there with the sender unable to tell, which is the failure mode of
 * requiring acceptance in the first place.
 *
 * The default stays incoming and stays a bare array, because the web dashboard
 * and the phone app both already read it that way.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const outgoing = req.nextUrl.searchParams.get("direction") === "outgoing"

  const pending = await prisma.caseTransfer.findMany({
    where: outgoing
      ? { fromUserId: user.id, status: "PENDING" }
      : { toUserId: user.id, status: "PENDING" },
    include: {
      case: {
        include: { preop: { select: { plannedProcedure: true, diagnosis: true } } },
      },
      // Whoever the sender is looking at is the recipient, and vice versa. Both
      // are selected so one response shape serves both directions.
      fromUser: { select: { name: true, title: true } },
      toUser: { select: { name: true, title: true } },
    },
    orderBy: { createdAt: "desc" },
  })

  return NextResponse.json(
    pending.map((transfer) => ({
      ...transfer,
      procedureName: transfer.case.preop?.plannedProcedure ?? transfer.case.preop?.diagnosis ?? null,
    }))
  )
}
