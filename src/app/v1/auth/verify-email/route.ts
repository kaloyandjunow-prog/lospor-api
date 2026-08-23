import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { hashAuthToken } from "@/lib/auth-email-tokens"
import { appUrl } from "@/lib/transactional-email"
import { logAuditInTransaction } from "@/lib/audit"
import { publicEmailAuthenticationRefusal } from "@/lib/deployment-capabilities"

class VerificationClaimFailed extends Error {}

export async function GET(req: NextRequest) {
  const deploymentRefusal = publicEmailAuthenticationRefusal()
  if (deploymentRefusal) {
    return NextResponse.json(deploymentRefusal.body, { status: deploymentRefusal.status })
  }
  const token = req.nextUrl.searchParams.get("token") ?? ""
  if (token.length < 20) {
    return NextResponse.redirect(appUrl("/verify-email?status=invalid"))
  }

  const now = new Date()
  const verificationToken = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashAuthToken(token) },
    include: { user: true },
  })

  if (
    !verificationToken
    || verificationToken.usedAt
    || verificationToken.expiresAt < now
    || verificationToken.user.deletedAt
    || verificationToken.user.suspendedAt
    || verificationToken.user.anonymizedAt
  ) {
    return NextResponse.redirect(appUrl("/verify-email?status=invalid"))
  }

  try {
    await prisma.$transaction(async transaction => {
      const claimed = await transaction.emailVerificationToken.updateMany({
        where: { id: verificationToken.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      })
      if (claimed.count !== 1) throw new VerificationClaimFailed()
      const verified = await transaction.user.updateMany({
        where: {
          id: verificationToken.userId,
          deletedAt: null,
          suspendedAt: null,
          anonymizedAt: null,
        },
        data: {
          // Email ownership is the public-demo activation gate. The account is
          // an ordinary MEMBER immediately after this succeeds.
          emailVerifiedAt: verificationToken.user.emailVerifiedAt ?? now,
          activatedAt: verificationToken.user.activatedAt ?? now,
        },
      })
      if (verified.count !== 1) throw new VerificationClaimFailed()
      await transaction.emailVerificationToken.updateMany({
        where: { userId: verificationToken.userId, usedAt: null },
        data: { usedAt: now },
      })
      await logAuditInTransaction(
        transaction,
        verificationToken.userId,
        "ACCOUNT_ACTIVATE",
        verificationToken.userId,
        { activationMethod: "EMAIL_VERIFICATION" },
      )
    })
  } catch (error) {
    if (error instanceof VerificationClaimFailed) {
      return NextResponse.redirect(appUrl("/verify-email?status=invalid"))
    }
    throw error
  }

  return NextResponse.redirect(appUrl("/verify-email?status=verified"))
}
