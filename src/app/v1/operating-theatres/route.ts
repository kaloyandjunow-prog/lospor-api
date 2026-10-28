import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { readOperatingTheatreConfig } from "@/lib/operating-theatres"

// Whether this site assigns operating theatres, and the ones it offers
// (10.0.0). Off, the apps show no theatre anywhere.
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

export async function GET(req: NextRequest) {
  if (!await getAuthUser(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json(await readOperatingTheatreConfig(prisma), { headers: corsHeaders(req) })
}
