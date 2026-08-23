import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { AUDIT_ACTION_REGISTRY, isAuditActionCode } from "@/lib/audit-actions"

const PAGE_SIZE = 50

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!requireRole(user, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const requestedPage = Number.parseInt(req.nextUrl.searchParams.get("page") ?? "0", 10)
  const page   = Number.isFinite(requestedPage) ? Math.max(0, requestedPage) : 0
  const action = req.nextUrl.searchParams.get("action") ?? ""
  if (action && !isAuditActionCode(action)) {
    return NextResponse.json(
      { error: "Unknown audit action", code: "UNKNOWN_AUDIT_ACTION" },
      { status: 400 },
    )
  }

  const where = action ? { action } : {}

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip:    page * PAGE_SIZE,
      take:    PAGE_SIZE,
    }),
  ])

  const userIds = [...new Set(logs.map(l => l.userId))]
  const [users, technicalPrincipals] = await Promise.all([
    prisma.user.findMany({
      where:  { id: { in: userIds } },
      select: { id: true, name: true, firstName: true, lastName: true, title: true },
    }),
    prisma.technicalPrincipal.findMany({
      where: { id: { in: userIds } },
      select: { id: true, displayName: true },
    }),
  ])
  const userMap = Object.fromEntries(users.map(u => [u.id, u]))
  const technicalPrincipalMap = Object.fromEntries(technicalPrincipals.map(principal => [
    principal.id,
    { name: principal.displayName },
  ]))

  const rows = logs.map(l => ({
    id:        l.id,
    createdAt: l.createdAt,
    action:    l.action,
    entityId:  l.entityId,
    detail:    l.detail,
    user:      userMap[l.userId] ?? technicalPrincipalMap[l.userId] ?? { name: l.userId },
  }))

  return NextResponse.json({
    logs: rows,
    total,
    page,
    pageSize: PAGE_SIZE,
    actions: AUDIT_ACTION_REGISTRY,
  })
}
