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
// accept and decline are the recipient's; cancel is the sender's. They are one
// endpoint because they all resolve the same pending row, and one row may only
// be resolved once.
const patchSchema = z.object({ action: z.enum(["accept", "decline", "cancel"]) })

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

  // A head of department or an administrator *assigns*: the case moves at once,
  // because the authority to reassign work is the authority they hold. Anyone
  // else *asks*: the case stays exactly where it is until the recipient accepts.
  //
  // The distinction is the point. Handing a case on is an ordinary clinical act
  // — a shift ends, or a pre-assessment was done days earlier by someone who
  // will not be in that theatre — and refusing it outright, as this did, only
  // moves the handover somewhere undocumented. But a peer carries no authority
  // over another's list, so nobody may be made the owner of a clinical record
  // without agreeing to it.
  const canAssignInstantly = user.role === "HEAD_OF_DEPT" || user.role === "ADMIN"

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

        if (!canAssignInstantly) {
          // One pending handover at a time. Two people cannot both be waiting to
          // be told the case is theirs, and whichever accepted second would find
          // it already renumbered under someone else.
          const alreadyPending = await tx.caseTransfer.findFirst({
            where: { caseId, status: "PENDING" },
            select: { id: true, toUserId: true },
          })
          if (alreadyPending) {
            return NextResponse.json({
              error: "This case is already waiting to be accepted",
              code: "TRANSFER_ALREADY_PENDING",
            }, { status: 409 })
          }

          // Nothing moves. Ownership, the case code and every access rule stay
          // as they were, so the sender can carry on documenting while they wait
          // — which is the normal situation, not an edge case: you hand over at
          // the end of a shift you are still working.
          const transfer = await tx.caseTransfer.create({
            data: {
              caseId,
              fromUserId: caseRecord.userId,
              toUserId,
              initiatedBy: user.id,
              status: "PENDING",
            },
          })
          await logAuditInTransaction(tx, user.id, "CASE_TRANSFER_REQUEST", caseId, {
            fromUserId: caseRecord.userId,
            toUserId,
            caseCode: caseRecord.caseCode,
          })
          return { instant: false as const, transfer }
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
        //
        // fromUserId is recorded explicitly. Without it the losing owner is
        // recoverable only from the CaseTransfer row, so the audit trail alone
        // could not answer "whose case was this before".
        await logAuditInTransaction(tx, user.id, "CASE_TRANSFER_ASSIGN", caseId, {
          fromUserId: caseRecord.userId,
          toUserId,
          instant: true,
          previousCaseCode: outcome.previousCaseCode,
          caseCode: outcome.caseCode,
        })
        return { instant: true as const, outcome, transfer }
      })

      if (result instanceof Response) return result
      if (!result.instant) {
        return NextResponse.json({ instant: false, transfer: result.transfer })
      }
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
    return NextResponse.json(
      { error: "action must be accept, decline or cancel" },
      { status: 400 },
    )
  }
  const { action } = parsed.data

  for (let attempt = 0; ; attempt++) {
    try {
      const result = await withLockedCaseTransaction(caseId, async tx => {
        // Who may resolve this pending row depends on which way they are
        // resolving it. Matching on the acting user rather than checking
        // afterwards means a stranger gets the same 404 as someone with no
        // pending transfer, and learns nothing about the case either way.
        const transfer = await tx.caseTransfer.findFirst({
          where: action === "cancel"
            ? { caseId, fromUserId: user.id, status: "PENDING" }
            : { caseId, toUserId: user.id, status: "PENDING" },
        })
        if (!transfer) {
          return NextResponse.json({ error: "No pending transfer found" }, { status: 404 })
        }

        if (action === "accept") {
          // A finalized case is an attested record, and accepting one would
          // reassign it underneath that attestation. POST refuses this; without
          // the same check here a case finalized while the handover sat pending
          // could still change hands.
          const caseRecord = await tx.case.findUnique({
            where: { id: caseId },
            select: { status: true },
          })
          if (caseRecord?.status === "COMPLETE") {
            return NextResponse.json(
              { error: "Unfinalise the case before transferring it" },
              { status: 409 },
            )
          }

          const outcome = await transferCaseOwnershipInTransaction(tx, caseId, user.id, {
            acceptTransferId: transfer.id,
          })
          await logAuditInTransaction(tx, user.id, "CASE_TRANSFER_ACCEPT", caseId, {
            fromUserId: transfer.fromUserId,
            toUserId: user.id,
            previousCaseCode: outcome.previousCaseCode,
            caseCode: outcome.caseCode,
          })
          return { action: "accept" as const, outcome }
        }

        // Declined by the recipient and withdrawn by the sender are different
        // events, and a trail that recorded both as DECLINED could not answer
        // whether a colleague refused the case or the sender thought better of
        // it. Distinct status, distinct audit action.
        const status = action === "cancel" ? "CANCELLED" : "DECLINED"
        await tx.caseTransfer.update({
          where: { id: transfer.id },
          data: { status, resolvedAt: new Date() },
        })
        await logAuditInTransaction(
          tx,
          user.id,
          action === "cancel" ? "CASE_TRANSFER_CANCEL" : "CASE_TRANSFER_DECLINE",
          caseId,
          { fromUserId: transfer.fromUserId, toUserId: transfer.toUserId },
        )
        return { action }
      })

      if (result instanceof Response) return result
      if (result.action === "accept") {
        return NextResponse.json({
          accepted: true,
          caseCode: result.outcome.caseCode,
          previousCaseCode: result.outcome.previousCaseCode,
        })
      }
      if (result.action === "cancel") return NextResponse.json({ cancelled: true })

      return NextResponse.json({ declined: true })
    } catch (error: unknown) {
      if (isPrismaUniqueError(error, "caseCode") && attempt < 4) continue
      return transferError(error, caseId)
    }
  }
}
