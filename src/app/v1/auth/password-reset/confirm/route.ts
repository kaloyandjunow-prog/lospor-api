import { NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { hashAuthToken } from "@/lib/auth-email-tokens"
import { notePasswordChanged } from "@/lib/password-epoch"
import { passwordSchema } from "@/lib/password-policy"

const schema = z.object({
  token: z.string().min(20),
  password: passwordSchema,
})

export async function POST(req: NextRequest) {
  let data: z.infer<typeof schema>
  try {
    data = schema.parse(await req.json())
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request"
    return NextResponse.json({ error: message ?? "Invalid request" }, { status: 400 })
  }

  const now = new Date()
  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashAuthToken(data.token) },
    include: { user: true },
  })

  if (!resetToken || resetToken.usedAt || resetToken.expiresAt < now || resetToken.user.deletedAt) {
    return NextResponse.json({ error: "Invalid or expired reset link" }, { status: 400 })
  }

  const passwordHash = await bcrypt.hash(data.password, 12)
  await prisma.$transaction([
    prisma.user.update({
      where: { id: resetToken.userId },
      // passwordChangedAt is the token-revocation epoch: web sessions and
      // mobile bearer JWTs issued before it are rejected (password-epoch.ts),
      // so a reset actually terminates existing sessions everywhere.
      data: { passwordHash, passwordChangedAt: now },
    }),
    prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: now },
    }),
    prisma.passwordResetToken.updateMany({
      where: { userId: resetToken.userId, usedAt: null, id: { not: resetToken.id } },
      data: { usedAt: now },
    }),
  ])
  // Prime this instance's cache immediately (other instances catch up within
  // the 5-minute refresh — same SLA as jti revocation).
  notePasswordChanged(resetToken.userId, now)

  return NextResponse.json({ ok: true })
}
