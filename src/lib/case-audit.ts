import type { PrismaClient, Prisma } from "@/generated/prisma/client"

type Db = PrismaClient

// ── Theme D: per-field preop/postop change log ────────────────────────────────
// Called best-effort after the save transaction commits. Never throws.

const SKIP_FIELDS = new Set(["createdAt", "updatedAt", "id", "caseId", "preopId"])

function serialise(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

export function writeFieldDiffsSafe(
  db: Db,
  caseId: string,
  section: "preop" | "postop",
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  userId: string
): Promise<void> {
  return writeFieldDiffs(db, caseId, section, existing, incoming, userId)
    .catch(err => console.error("[case-audit:diff]", caseId, section, err))
}

async function writeFieldDiffs(
  db: Db,
  caseId: string,
  section: "preop" | "postop",
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  userId: string
): Promise<void> {
  const changes: { caseId: string; section: string; field: string; oldValue: string | null; newValue: string | null; userId: string }[] = []

  for (const [field, newVal] of Object.entries(incoming)) {
    if (SKIP_FIELDS.has(field)) continue
    if (newVal === undefined) continue
    const oldVal = existing[field]
    const oldStr = serialise(oldVal)
    const newStr = serialise(newVal)
    if (oldStr === newStr) continue
    changes.push({ caseId, section, field, oldValue: oldStr, newValue: newStr, userId })
  }

  if (changes.length === 0) return
  await db.caseFieldChange.createMany({ data: changes })
}

// ── Theme E: immutable finalization snapshot ──────────────────────────────────
// Written when a case transitions to COMPLETE. Never throws.

export function writeSnapshotSafe(db: Db, caseId: string): void {
  writeSnapshot(db, caseId)
    .catch(err => console.error("[case-audit:snapshot]", caseId, err))
}

// Throwing version used by the finalize endpoint — caller must handle errors.
export async function writeSnapshotAsync(db: Db, caseId: string): Promise<void> {
  return writeSnapshot(db, caseId)
}

async function writeSnapshot(db: Db, caseId: string): Promise<void> {
  const c = await db.case.findUnique({
    where: { id: caseId },
    include: { preop: true, intraop: true, postop: true },
  })
  if (!c) return

  const snapshotJson = c as unknown as Prisma.InputJsonValue
  await db.caseSnapshot.upsert({
    where:  { caseId },
    update: { snapshotJson, finalizedAt: new Date() },
    create: { caseId, schemaVersion: "3.0.0", snapshotJson },
  })
}
