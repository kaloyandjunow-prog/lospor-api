import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { caseWhereForUser } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { corsHeaders } from "@/lib/cors"

// Cheap "has this case changed?" probe for live refresh.
//
// Live updates used to be pushed over SSE from an in-process EventEmitter,
// which cannot work on serverless: the request that writes the change and the
// request holding the stream open run in different instances, so the listener
// was never notified and the stream sat silent. Clients poll this instead —
// a few timestamps rather than the whole case, so a colleague can watch a case
// without refetching the full record every few seconds.
const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS(req) })

  const { id } = await params
  const found = await prisma.case.findFirst({
    where: caseWhereForUser(user, id),
    select: {
      updatedAt: true,
      status:    true,
      preop:   { select: { updatedAt: true, syncRevision: true } },
      intraop: { select: { updatedAt: true, syncRevision: true } },
      postop:  { select: { updatedAt: true, syncRevision: true } },
    },
  })
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404, headers: CORS(req) })

  return NextResponse.json({
    updatedAt:        found.updatedAt,
    status:           found.status,
    preopUpdatedAt:   found.preop?.updatedAt ?? null,
    intraopUpdatedAt: found.intraop?.updatedAt ?? null,
    postopUpdatedAt:  found.postop?.updatedAt ?? null,
    preopRevision:    found.preop?.syncRevision ?? null,
    intraopRevision:  found.intraop?.syncRevision ?? null,
    postopRevision:   found.postop?.syncRevision ?? null,
  }, { headers: CORS(req) })
}
