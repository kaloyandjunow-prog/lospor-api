import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

/**
 * Readiness, plus whether this installation can actually send email.
 *
 * Without a mail provider nobody can verify an address, and a verified address
 * is a condition of signing in — so an installation with no BREVO_API_KEY
 * accepts registrations and then strands every one of them. That failure was
 * invisible: a warning in the logs nobody reads, and a 201 to the client as
 * though all was well.
 *
 * Reported, not enforced. A register whose administrators verify accounts by
 * hand is a legitimate deployment; one that has simply forgotten to configure
 * mail is not, and this is how the difference becomes visible. Only whether a
 * key is present is disclosed — never the key.
 */
export async function GET() {
  const email = process.env.BREVO_API_KEY ? "configured" : "not-configured"
  try {
    await prisma.$queryRaw`SELECT 1`
    return NextResponse.json({ status: "ready", database: "ok", email })
  } catch {
    return NextResponse.json(
      { status: "unavailable", database: "error", email },
      { status: 503 },
    )
  }
}
