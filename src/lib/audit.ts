import type { Prisma, PrismaClient } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import type { AuditActionCode } from "@/lib/audit-actions"

type Db = PrismaClient | Prisma.TransactionClient

const FORBIDDEN_DETAIL_KEYS = new Set([
  "address",
  "casecode",
  "clinicalpayload",
  "email",
  "firstname",
  "fullname",
  "lastname",
  "name",
  "password",
  "passwordhash",
  "patientid",
  "patientnumber",
  "payload",
  "phone",
  "secret",
  "token",
  "tokenhash",
])

function normalizedDetailKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Fails closed when a caller tries to place obvious credentials, patient
 * numbers, raw clinical payloads, or direct account PII in audit JSON.
 * Stable opaque entity/user IDs remain permitted because they are required to
 * prove who acted on what.
 */
export function assertSafeAuditDetail(detail: object | undefined): void {
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizedDetailKey(key)
      if (
        FORBIDDEN_DETAIL_KEYS.has(normalized)
        || normalized.endsWith("password")
        || normalized.endsWith("passwordhash")
        || normalized.endsWith("token")
        || normalized.endsWith("tokenhash")
        || normalized.endsWith("secret")
        || normalized.endsWith("casecode")
        || normalized.endsWith("patientnumber")
        || normalized.endsWith("clinicalpayload")
      ) {
        throw new Error(`Unsafe audit detail field: ${key}`)
      }
      visit(child)
    }
  }
  visit(detail)
}

/**
 * Record an act that must be provable, in the same transaction that performs it.
 *
 * The audit log lives in the same database as the thing it describes, so there
 * is no reason for the two to commit separately — and every reason for them not
 * to. Written this way the entry and the change it records commit together or
 * neither does.
 *
 * This exists because the alternative was in use for the acts that most need
 * evidence. `logAudit` swallows its own failures by design, and the callers
 * that mattered — transfer, finalization, unfinalization — invoked it through
 * `after()`, which by definition runs once the response has been sent. A
 * process interruption between the commit and that callback left the mutation
 * in place with nothing recording it, and no error anywhere.
 *
 * Use this for anything whose absence from the audit log would be a problem:
 * ownership changes, finalization, patient re-linking, access grants. It
 * throws, and it is meant to — if the evidence cannot be written, the act it
 * describes should not stand either.
 */
export async function logAuditInTransaction(
  db: Db,
  userId: string,
  action: AuditActionCode,
  entityId: string,
  detail?: object,
): Promise<void> {
  assertSafeAuditDetail(detail)
  await db.auditLog.create({ data: { userId, action, entityId, detail } })
}

/**
 * Best-effort audit for acts where losing the entry is survivable.
 *
 * Intentionally non-throwing: a failed audit write must not abort business
 * logic. That trade is right for routine, high-volume records — event edits,
 * case updates, blocked PII — and wrong for anything above; prefer
 * logAuditInTransaction where the evidence is the point.
 *
 * Callers should still await it so the write attempt completes before the
 * response is sent.
 */
export async function logAudit(
  userId: string,
  action: AuditActionCode,
  entityId: string,
  detail?: object,
): Promise<void> {
  try {
    assertSafeAuditDetail(detail)
    await prisma.auditLog.create({ data: { userId, action, entityId, detail } })
  } catch (err) {
    console.error("[audit] Failed to write audit log:", err)
    // Do not rethrow — audit failure must not abort the caller's business logic.
  }
}
