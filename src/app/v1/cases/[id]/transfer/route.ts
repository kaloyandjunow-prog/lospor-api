import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { caseWhereForUser } from "@/lib/access-control"
import { logAuditInTransaction } from "@/lib/audit"
import { transferCaseOwnershipInTransaction } from "@/lib/case-transfer"
import { isPrismaUniqueError } from "@/lib/case-code"
import { CaseWriteError, withLockedCaseTransaction } from "@/lib/clinical-transaction"
import { z } from "zod"

const postSchema  = z.object({ toUserId: z.string().min(1) })
const patchSchema = z.object({ action: z.enum(["accept", "decline"]) })

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

function transferError(error: unknown, caseId: string) {
  if (error instanceof CaseWriteError) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }
  console.error("[case transfer]", caseId, error)
  return NextResponse.json({ error: "Internal server error" }, { status: 500 })
}

// POST - initiate a transfer
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: caseId } = await params
  const parsed = postSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: "toUserId required" }, { status: 400 })
  const { toUserId } = parsed.data
  if (toUserId === user.id) return NextResponse.json({ error: "Cannot transfer to yourself" }, { status: 400 })

  const isHOD = user.role === "HEAD_OF_DEPT"
  const isAdmin = user.role === "ADMIN"
  if (!isHOD && !isAdmin) {
    return NextResponse.json({ error: "Only HOD and admin can assign cases" }, { status: 403 })
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const result = await withLockedCaseTransaction(caseId, async tx => {
        const caseRecord = await tx.case.findFirst({ where: caseWhereForUser(user, caseId) })
        if (!caseRecord) return NextResponse.json({ error: "Case not found" }, { status: 404 })

        const recipient = await tx.user.findUnique({ where: { id: toUserId, deletedAt: null } })
        if (!recipient) return NextResponse.json({ error: "Recipient not found" }, { status: 400 })

        // A case stays at the hospital that recorded it. No exception for
        // administrators.
        //
        // An admin used to be able to transfer across institutions, and
        // transferCaseOwnershipInTransaction rewrote the case's institutionId
        // to the recipient's — so the record, the printed protocol and the OMOP
        // care_site all said the operation had happened somewhere it had not.
        // It also broke patient identity at the Central boundary: the patient
        // link's identifierHash is HMAC'd with the institution, and the export
        // pseudonym is built from the case's institution plus that hash, so
        // after such a move the two disagreed and the same patient reached
        // Central under an identity matching no link row anywhere.
        //
        // Where a case was genuinely recorded under the wrong account, the
        // correction belongs at the hospital that made it, not to a transfer
        // that quietly relocates the operation.
        if (recipient.institutionId !== caseRecord.institutionId) {
          return NextResponse.json({
            error: "A case cannot be transferred to another institution",
            code: "CROSS_INSTITUTION_TRANSFER",
          }, { status: 403 })
        }

        // A finalized case is an attested record. Reassigning it means
        // unfinalising it first, so the change is captured in a new
        // finalization rather than applied underneath the existing one.
        if (caseRecord.status === "COMPLETE") {
          return NextResponse.json({
            error: "Unfinalise the case before transferring it",
          }, { status: 409 })
        }

        const outcome = await transferCaseOwnershipInTransaction(tx, caseId, toUserId, {
          supersedePending: true,
        })
        const transfer = await tx.caseTransfer.create({
          data: {
            caseId,
            fromUserId: caseRecord.userId,
            toUserId,
            initiatedBy: user.id,
            status: "ACCEPTED",
            resolvedAt: new Date(),
            previousCaseCode: outcome.previousCaseCode,
          },
        })
        // In the transaction. A transfer changes who a clinical record
        // belongs to; committing that without a record of who did it is
        // the case where an audit log most needs to be trustworthy.
        await logAuditInTransaction(tx, user.id, "CASE_TRANSFER_ASSIGN", caseId, {
          toUserId,
          instant: true,
          previousCaseCode: outcome.previousCaseCode,
          caseCode: outcome.caseCode,
        })
        return { outcome, transfer }
      })

      if (result instanceof Response) return result
      return NextResponse.json({
        instant: true,
        transfer: result.transfer,
        caseCode: result.outcome.caseCode,
        previousCaseCode: result.outcome.previousCaseCode,
      })
    } catch (error: unknown) {
      if (isPrismaUniqueError(error, "caseCode") && attempt < 4) continue
      return transferError(error, caseId)
    }
  }
}

// PATCH - recipient accepts or declines
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: caseId } = await params
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: "action must be accept or decline" }, { status: 400 })
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const result = await withLockedCaseTransaction(caseId, async tx => {
        const transfer = await tx.caseTransfer.findFirst({
          where: { caseId, toUserId: user.id, status: "PENDING" },
        })
        if (!transfer) {
          return NextResponse.json({ error: "No pending transfer found" }, { status: 404 })
        }

        if (parsed.data.action === "accept") {
          const outcome = await transferCaseOwnershipInTransaction(tx, caseId, user.id, {
            acceptTransferId: transfer.id,
          })
          await logAuditInTransaction(tx, user.id, "CASE_TRANSFER_ACCEPT", caseId, {
            previousCaseCode: outcome.previousCaseCode,
            caseCode: outcome.caseCode,
          })
          return { action: "accept" as const, outcome }
        }

        await tx.caseTransfer.update({
          where: { id: transfer.id },
          data: { status: "DECLINED", resolvedAt: new Date() },
        })
        await logAuditInTransaction(tx, user.id, "CASE_TRANSFER_DECLINE", caseId)
        return { action: "decline" as const }
      })

      if (result instanceof Response) return result
      if (result.action === "accept") {
        return NextResponse.json({
          accepted: true,
          caseCode: result.outcome.caseCode,
          previousCaseCode: result.outcome.previousCaseCode,
        })
      }

      return NextResponse.json({ declined: true })
    } catch (error: unknown) {
      if (isPrismaUniqueError(error, "caseCode") && attempt < 4) continue
      return transferError(error, caseId)
    }
  }
}
