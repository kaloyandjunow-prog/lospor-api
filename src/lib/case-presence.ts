import { CASE_PRESENCE_TTL_MS, type CasePresence } from "@lospor/core/case-presence"
import { prisma } from "@/lib/prisma"

/**
 * One screen reports it has the case open (10.8.0), and gets back who else does. Rows older than the
 * presence window are dropped on the way, so the table stays as small as the people actually in cases.
 */
export async function touchCasePresence(input: { caseId: string; userId: string; deviceId: string }, now = new Date()): Promise<CasePresence> {
  const since = new Date(now.getTime() - CASE_PRESENCE_TTL_MS)
  // This case's old rows go on every heartbeat (the (caseId, seenAt) index serves it); the whole table is swept now and
  // then, so rows of cases nobody opens again do not stay.
  await prisma.casePresence.deleteMany({ where: { caseId: input.caseId, seenAt: { lt: since } } })
  if (Math.random() < 0.02) await prisma.casePresence.deleteMany({ where: { seenAt: { lt: since } } })
  const report = () => prisma.casePresence.upsert({
    where: { caseId_userId_deviceId: { caseId: input.caseId, userId: input.userId, deviceId: input.deviceId } },
    create: { ...input, seenAt: now },
    update: { seenAt: now },
  })
  try { await report() } catch (error) {
    // Two heartbeats of one screen can both find no row and both create one: the second is simply an update.
    if ((error as { code?: string }).code !== "P2002") throw error
    await report()
  }
  return readCasePresence(input.caseId, input.userId, now)
}

export async function readCasePresence(caseId: string, readerId: string, now = new Date()): Promise<CasePresence> {
  const since = new Date(now.getTime() - CASE_PRESENCE_TTL_MS)
  const rows = await prisma.casePresence.findMany({
    where: { caseId, seenAt: { gte: since } },
    select: { userId: true, user: { select: { name: true, username: true, email: true } } },
    orderBy: { seenAt: "asc" },
  })
  const people = new Map<string, { name: string; you: boolean }>()
  for (const row of rows) {
    if (people.has(row.userId)) continue
    people.set(row.userId, { name: row.user.name || row.user.username || row.user.email || "?", you: row.userId === readerId })
  }
  return { people: [...people.values()], screens: rows.length }
}

export async function leaveCasePresence(input: { caseId: string; userId: string; deviceId: string }): Promise<void> {
  await prisma.casePresence.deleteMany({ where: input })
}
