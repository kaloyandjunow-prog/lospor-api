import { NextRequest, NextResponse } from "next/server"
import { NURSE_ACCOUNT_ROLES } from "@lospor/core/clinical-roles"
import { z } from "zod"
import { calendarDayKey } from "@lospor/core/dashboard-date-scope"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { logAuditInTransaction } from "@/lib/audit"
import { isNurse, pinTheatreNurses } from "@/lib/nurse-access"
import { prisma } from "@/lib/prisma"

/**
 * Anaesthesia nurses on the operating theatres for a day (10.8.0). A nurse
 * puts herself on a theatre for today; a head of department or an
 * administrator puts any nurse of the department on any day.
 */
const bodySchema = z.object({
  theatreId: z.string().min(1).max(64),
  userId: z.string().min(1).max(64).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  remove: z.boolean().optional(),
}).strict()

const dateOf = (key: string) => new Date(`${key}T00:00:00.000Z`)
/** A real calendar day: 2026-02-31 passes the shape check but is not one, and would reach the database as an Invalid Date. */
const isRealDay = (key: string) => { const day = dateOf(key); return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === key }

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

async function shiftsFor(date: string, institutionId: string | null) {
  const rows = await prisma.theatreNurseShift.findMany({
    where: { shiftDate: dateOf(date), ...(institutionId ? { user: { institutionId } } : {}) },
    include: { user: { select: { id: true, name: true, firstName: true, lastName: true, title: true } }, theatre: { select: { id: true, name: true } } },
    orderBy: [{ theatreId: "asc" }, { createdAt: "asc" }],
  })
  return rows.map(row => ({ id: row.id, theatre: row.theatre, user: row.user, date }))
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const date = req.nextUrl.searchParams.get("date") ?? calendarDayKey(new Date())
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDay(date)) return NextResponse.json({ error: "Invalid date" }, { status: 400 })
  // A person with no institution sees nobody's shifts (an empty institution filter would be every hospital's).
  if (user.role !== "ADMIN" && !user.institutionId) return NextResponse.json({ date, shifts: [] }, { headers: corsHeaders(req) })
  return NextResponse.json({ date, shifts: await shiftsFor(date, user.role === "ADMIN" ? null : user.institutionId) }, { headers: corsHeaders(req) })
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "theatreId required" }, { status: 400 })
  const today = calendarDayKey(new Date())
  const date = parsed.data.date ?? today
  if (!isRealDay(date)) return NextResponse.json({ error: "Invalid date" }, { status: 400 })
  if (user.role !== "ADMIN" && !user.institutionId) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const nurseId = parsed.data.userId ?? user.id
  const manager = user.role === "ADMIN" || user.role === "HEAD_OF_DEPT"
  // A nurse manages only her own place, and only today.
  if (!manager && !(isNurse(user) && nurseId === user.id && date === today)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const nurse = await prisma.user.findFirst({
    where: { id: nurseId, role: { in: [...NURSE_ACCOUNT_ROLES] }, deletedAt: null, ...(user.role === "ADMIN" || !user.institutionId ? {} : { institutionId: user.institutionId }) },
    select: { id: true },
  })
  if (!nurse) return NextResponse.json({ error: "Not an anaesthesia nurse", code: "NOT_A_NURSE" }, { status: 400 })
  const theatre = await prisma.operatingTheatre.findFirst({ where: { id: parsed.data.theatreId, active: true }, select: { id: true } })
  if (!theatre) return NextResponse.json({ error: "Unknown theatre" }, { status: 400 })

  await prisma.$transaction(async tx => {
    if (parsed.data.remove) {
      await tx.theatreNurseShift.deleteMany({ where: { theatreId: theatre.id, userId: nurse.id, shiftDate: dateOf(date) } })
      await logAuditInTransaction(tx, user.id, "THEATRE_NURSE_SHIFT_CLEAR", theatre.id, { nurse: nurse.id, date })
    } else {
      await tx.theatreNurseShift.upsert({
        where: { theatreId_userId_shiftDate: { theatreId: theatre.id, userId: nurse.id, shiftDate: dateOf(date) } },
        create: { theatreId: theatre.id, userId: nurse.id, shiftDate: dateOf(date), assignedById: user.id },
        update: {},
      })
      await pinTheatreNurses(tx, { theatreId: theatre.id, shiftDate: date, userId: nurse.id, today })
      await logAuditInTransaction(tx, user.id, "THEATRE_NURSE_SHIFT_SET", theatre.id, { nurse: nurse.id, date })
    }
  })
  return NextResponse.json({ date, shifts: await shiftsFor(date, user.role === "ADMIN" ? null : user.institutionId) }, { headers: corsHeaders(req) })
}
