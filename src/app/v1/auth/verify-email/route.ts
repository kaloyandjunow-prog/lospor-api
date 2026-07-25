import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { hashAuthToken } from "@/lib/auth-email-tokens"
import { appUrl } from "@/lib/transactional-email"

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? ""
  if (token.length < 20) {
    return NextResponse.redirect(appUrl("/verify-email?status=invalid"))
  }

  const now = new Date()
  const verificationToken = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashAuthToken(token) },
    include: { user: true },
  })

  if (!verificationToken || verificationToken.usedAt || verificationToken.expiresAt < now || verificationToken.user.deletedAt) {
    return NextResponse.redirect(appUrl("/verify-email?status=invalid"))
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: verificationToken.userId },
      data: {
        emailVerifiedAt: verificationToken.user.emailVerifiedAt ?? now,
        approvedAt: verificationToken.user.approvedAt ?? now,
      },
    }),
    prisma.emailVerificationToken.update({
      where: { id: verificationToken.id },
      data: { usedAt: now },
    }),
    prisma.emailVerificationToken.updateMany({
      where: { userId: verificationToken.userId, usedAt: null, id: { not: verificationToken.id } },
      data: { usedAt: now },
    }),
  ])

  return NextResponse.redirect(appUrl("/verify-email?status=verified"))
}
