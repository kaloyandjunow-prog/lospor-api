import type { Prisma, PrismaClient } from "@/generated/prisma/client"
import {
  normalizeTheatreName,
  theatreChangeAllowed,
  type OperatingTheatreConfig,
} from "@lospor/core/operating-theatres"

/**
 * Operating theatres (10.0.0). A site switches them on and names them in
 * Status; clinicians assign one to a case from the dashboard until intraop
 * starts. Off, the apps show nothing of it.
 */

type Db = PrismaClient | Prisma.TransactionClient

export class OperatingTheatreError extends Error {
  constructor(readonly code: string, readonly status = 400, readonly details: Record<string, unknown> = {}) {
    super(code)
  }
}

const POLICY_ID = "local"

export async function operatingTheatresEnabled(db: Db): Promise<boolean> {
  const policy = await db.operatingTheatrePolicy.findUnique({ where: { id: POLICY_ID } })
  return policy?.enabled === true
}

/** What the apps read: whether theatres are on, and the active ones in order. */
export async function readOperatingTheatreConfig(db: Db): Promise<OperatingTheatreConfig> {
  if (!await operatingTheatresEnabled(db)) return { enabled: false, theatres: [] }
  const theatres = await db.operatingTheatre.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true },
  })
  return { enabled: true, theatres }
}

/** The case fields every read of a case's theatre needs. */
export const CASE_THEATRE_SELECT = {
  operatingTheatreId: true,
  operatingTheatreName: true,
  operatingTheatre: { select: { name: true } },
} satisfies Prisma.CaseSelect

/**
 * Assigns a theatre to a case, or clears it (null). Refused while theatres are
 * off, for a theatre retired or unknown, and once intraop has started.
 *
 * `expected` is the theatre the clinician saw when choosing (null for none).
 * If the case has been given another meanwhile, the change is refused with
 * THEATRE_CHANGED, naming the theatre it has now and who set it, so a second
 * person cannot silently overwrite the first. Left out (older clients), the
 * last save wins as before.
 */
export async function assignCaseTheatre(
  tx: Prisma.TransactionClient,
  caseId: string,
  theatreId: string | null,
  expected?: string | null,
): Promise<{ before: string | null; after: string | null }> {
  if (!await operatingTheatresEnabled(tx)) throw new OperatingTheatreError("OPERATING_THEATRES_OFF", 409)
  const record = await tx.case.findUnique({
    where: { id: caseId },
    select: { status: true, operatingTheatreId: true, intraop: { select: { startedAt: true, startTime: true } } },
  })
  if (!record) throw new OperatingTheatreError("CASE_NOT_FOUND", 404)
  // A cancelled procedure says so, rather than claiming intraop has started (10.0.0).
  if (record.status === "CANCELLED") throw new OperatingTheatreError("CASE_CANCELLED", 409)
  if (!theatreChangeAllowed(record)) throw new OperatingTheatreError("THEATRE_LOCKED_INTRAOP_STARTED", 409)
  if (expected !== undefined && expected !== record.operatingTheatreId) {
    throw new OperatingTheatreError("THEATRE_CHANGED", 409, await theatreChangedDetails(tx, caseId, record.operatingTheatreId))
  }
  if (theatreId !== null) {
    const theatre = await tx.operatingTheatre.findUnique({ where: { id: theatreId }, select: { active: true } })
    if (!theatre?.active) throw new OperatingTheatreError("THEATRE_NOT_FOUND", 404)
  }
  if (record.operatingTheatreId !== theatreId) {
    await tx.case.update({ where: { id: caseId }, data: { operatingTheatreId: theatreId } })
  }
  return { before: record.operatingTheatreId, after: theatreId }
}

/** What a refused change says: the theatre the case has now, and who set it last. */
async function theatreChangedDetails(tx: Prisma.TransactionClient, caseId: string, currentId: string | null) {
  const [theatre, last] = await Promise.all([
    currentId ? tx.operatingTheatre.findUnique({ where: { id: currentId }, select: { id: true, name: true } }) : null,
    tx.auditLog.findFirst({ where: { action: "CASE_THEATRE_ASSIGN", entityId: caseId }, orderBy: { createdAt: "desc" }, select: { userId: true } }),
  ])
  const user = last ? await tx.user.findUnique({ where: { id: last.userId }, select: { name: true } }) : null
  return { current: theatre ?? null, changedBy: user?.name ?? null }
}

/**
 * Keeps the theatre's name on a case once intraop has started, so a later
 * rename does not rewrite where it happened. Called after every intraop save;
 * does nothing until there is a start, a theatre and no name kept yet.
 */
export async function keepTheatreNameAtStart(tx: Prisma.TransactionClient, caseId: string): Promise<void> {
  const record = await tx.case.findUnique({
    where: { id: caseId },
    select: {
      operatingTheatreName: true,
      operatingTheatre: { select: { name: true } },
      intraop: { select: { startedAt: true, startTime: true } },
    },
  })
  if (!record?.operatingTheatre || record.operatingTheatreName) return
  if (!record.intraop?.startedAt && !record.intraop?.startTime) return
  await tx.case.update({ where: { id: caseId }, data: { operatingTheatreName: record.operatingTheatre.name } })
}

/**
 * Before a theatre is renamed or retired: every started case of it that has
 * not kept the name yet keeps it now. A finalised case is never written
 * (standing rule); its name was kept when it started.
 */
async function keepNamesOfStartedCases(tx: Prisma.TransactionClient, theatreId: string, name: string): Promise<number> {
  const { count } = await tx.case.updateMany({
    where: {
      operatingTheatreId: theatreId,
      operatingTheatreName: null,
      status: { not: "COMPLETE" },
      intraop: { OR: [{ startedAt: { not: null } }, { startTime: { not: null } }] },
    },
    data: { operatingTheatreName: name },
  })
  return count
}

// ── Status (appliance control plane) ──────────────────────────────────────

export type OperatingTheatreAdminRow = { id: string; name: string; active: boolean; sortOrder: number; caseCount: number }
export type OperatingTheatresAdminView = { enabled: boolean; theatres: OperatingTheatreAdminRow[] }

/** Every theatre, retired ones included, with how many cases name it. */
export async function operatingTheatresAdminView(db: Db): Promise<OperatingTheatresAdminView> {
  const [enabled, theatres] = await Promise.all([
    operatingTheatresEnabled(db),
    db.operatingTheatre.findMany({
      orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, active: true, sortOrder: true, _count: { select: { cases: true } } },
    }),
  ])
  return {
    enabled,
    theatres: theatres.map(({ _count, ...theatre }) => ({ ...theatre, caseCount: _count.cases })),
  }
}

export type OperatingTheatreChange =
  | { action: "policy"; enabled: boolean }
  | { action: "add"; name: string }
  | { action: "rename"; id: string; name: string }
  | { action: "retire"; id: string }
  | { action: "restore"; id: string }
  | { action: "move"; id: string; direction: "up" | "down" }

async function uniqueName(tx: Prisma.TransactionClient, name: string, exceptId?: string): Promise<string> {
  const normalized = normalizeTheatreName(name)
  if (!normalized) throw new OperatingTheatreError("THEATRE_NAME_INVALID")
  const clash = await tx.operatingTheatre.findFirst({
    where: { active: true, name: { equals: normalized, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  })
  if (clash) throw new OperatingTheatreError("THEATRE_NAME_TAKEN", 409)
  return normalized
}

async function existing(tx: Prisma.TransactionClient, id: string) {
  const theatre = await tx.operatingTheatre.findUnique({ where: { id } })
  if (!theatre) throw new OperatingTheatreError("THEATRE_NOT_FOUND", 404)
  return theatre
}

/** One change an operator makes in Status. Returns what it did, for the audit. */
export async function changeOperatingTheatres(tx: Prisma.TransactionClient, change: OperatingTheatreChange): Promise<Record<string, unknown>> {
  switch (change.action) {
    case "policy": {
      await tx.operatingTheatrePolicy.upsert({
        where: { id: POLICY_ID },
        create: { id: POLICY_ID, enabled: change.enabled },
        update: { enabled: change.enabled },
      })
      return { enabled: change.enabled }
    }
    case "add": {
      const name = await uniqueName(tx, change.name)
      const last = await tx.operatingTheatre.aggregate({ _max: { sortOrder: true } })
      const theatre = await tx.operatingTheatre.create({ data: { name, sortOrder: (last._max.sortOrder ?? -1) + 1 } })
      return { theatreId: theatre.id }
    }
    case "rename": {
      const theatre = await existing(tx, change.id)
      const name = await uniqueName(tx, change.name, theatre.id)
      const kept = await keepNamesOfStartedCases(tx, theatre.id, theatre.name)
      await tx.operatingTheatre.update({ where: { id: theatre.id }, data: { name } })
      return { theatreId: theatre.id, startedCasesKeptName: kept }
    }
    case "retire": {
      const theatre = await existing(tx, change.id)
      const kept = await keepNamesOfStartedCases(tx, theatre.id, theatre.name)
      await tx.operatingTheatre.update({ where: { id: theatre.id }, data: { active: false } })
      return { theatreId: theatre.id, startedCasesKeptName: kept }
    }
    case "restore": {
      const theatre = await existing(tx, change.id)
      await uniqueName(tx, theatre.name, theatre.id)
      const last = await tx.operatingTheatre.aggregate({ where: { active: true }, _max: { sortOrder: true } })
      await tx.operatingTheatre.update({ where: { id: theatre.id }, data: { active: true, sortOrder: (last._max.sortOrder ?? -1) + 1 } })
      return { theatreId: theatre.id }
    }
    case "move": {
      const theatre = await existing(tx, change.id)
      const active = await tx.operatingTheatre.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true } })
      const index = active.findIndex(row => row.id === theatre.id)
      const target = change.direction === "up" ? index - 1 : index + 1
      if (index < 0 || target < 0 || target >= active.length) return { theatreId: theatre.id, moved: false }
      const order = active.map(row => row.id)
      ;[order[index], order[target]] = [order[target], order[index]]
      for (const [position, id] of order.entries()) {
        await tx.operatingTheatre.update({ where: { id }, data: { sortOrder: position } })
      }
      return { theatreId: theatre.id, moved: true }
    }
  }
}
