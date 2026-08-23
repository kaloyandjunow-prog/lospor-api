import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { logAuditInTransaction } from "@/lib/audit"
import { invalidateAccountState } from "@/lib/password-epoch"
import { accountAdministrationRefusal } from "@/lib/deployment-capabilities"

const schema = z.object({ reason: z.string().trim().min(3).max(500) }).strict()

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const deploymentRefusal = accountAdministrationRefusal()
  if (deploymentRefusal) {
    return NextResponse.json(deploymentRefusal.body, { status: deploymentRefusal.status })
  }
  const actor = await getAuthUser(request)
  if (!requireRole(actor, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const { id } = await params
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "A reason is required" }, { status: 400 })

  const outcome = await prisma.$transaction(async transaction => {
    const target = await transaction.user.findUnique({
      where: { id },
      select: { suspendedAt: true, deletedAt: true, anonymizedAt: true },
    })
    if (!target) return "NOT_FOUND" as const
    if (target.deletedAt || target.anonymizedAt) return "DELETED" as const
    if (!target.suspendedAt) return "NOT_SUSPENDED" as const
    const changed = await transaction.user.updateMany({
      where: { id, suspendedAt: { not: null }, deletedAt: null, anonymizedAt: null },
      data: { suspendedAt: null },
    })
    if (changed.count !== 1) return "CONFLICT" as const
    await logAuditInTransaction(transaction, actor.id, "ADMIN_ACCOUNT_REACTIVATE", id, {
      reason: parsed.data.reason,
    })
    return "OK" as const
  })

  if (outcome !== "OK") {
    return NextResponse.json(
      { error: outcome },
      { status: outcome === "NOT_FOUND" ? 404 : 409 },
    )
  }
  invalidateAccountState(id)
  return NextResponse.json({ ok: true })
}
