import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"

const PAGE_SIZE = 50

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!requireRole(user, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const page   = Math.max(0, parseInt(req.nextUrl.searchParams.get("page") ?? "0", 10))
  const action = req.nextUrl.searchParams.get("action") ?? ""

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
  const users   = await prisma.user.findMany({
    where:  { id: { in: userIds } },
    select: { id: true, name: true, firstName: true, lastName: true, title: true },
  })
  const userMap = Object.fromEntries(users.map(u => [u.id, u]))

  const rows = logs.map(l => ({
    id:        l.id,
    createdAt: l.createdAt,
    action:    l.action,
    entityId:  l.entityId,
    detail:    l.detail,
    user:      userMap[l.userId] ?? { name: l.userId },
  }))

  return NextResponse.json({ logs: rows, total, page, pageSize: PAGE_SIZE })
}
