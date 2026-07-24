import { prisma } from "@/lib/prisma"

// logAudit is intentionally non-throwing: a failed audit write must never
// abort business logic.  Callers should still await it so the write attempt
// completes (or fails with a logged error) before the response is sent.
export async function logAudit(
  userId: string,
  action: string,
  entityId: string,
  detail?: object,
): Promise<void> {
  try {
    await prisma.auditLog.create({ data: { userId, action, entityId, detail } })
  } catch (err) {
    console.error("[audit] Failed to write audit log:", err)
    // Do not rethrow — audit failure must not abort the caller's business logic.
  }
}
