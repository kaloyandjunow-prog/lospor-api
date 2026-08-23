import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { activeLegalManifest, LegalConfigurationError } from "@/lib/legal-documents"
import { administratorMfaKeyIsReady } from "@/lib/administrator-mfa"

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
  } catch {
    return NextResponse.json(
      { status: "unavailable", database: "error", email, legalDocuments: "unchecked", administratorMfa: "unchecked" },
      { status: 503 },
    )
  }

  try {
    const legal = activeLegalManifest()
    const mfaRequired = process.env.LOSPOR_ADMIN_MFA_REQUIRED === "true"
    const administratorMfa = mfaRequired
      ? (administratorMfaKeyIsReady() ? "configured" : "unavailable")
      : "not-required"
    if (administratorMfa === "unavailable") {
      return NextResponse.json({
        status: "unavailable",
        database: "ok",
        email,
        legalDocuments: "configured",
        legalDeployment: legal.deployment,
        administratorMfa,
      }, { status: 503 })
    }
    return NextResponse.json({
      status: "ready",
      database: "ok",
      email,
      legalDocuments: "configured",
      legalDeployment: legal.deployment,
      administratorMfa,
    })
  } catch (error) {
    if (!(error instanceof LegalConfigurationError)) throw error
    return NextResponse.json(
      { status: "unavailable", database: "ok", email, legalDocuments: "unavailable", administratorMfa: "unchecked" },
      { status: 503 },
    )
  }
}
