import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import {
  calculateMostellerBsa,
  calculatePediatricMaintenanceFluid,
  calculateRcukPediatricResuscitation,
} from "@lospor/core/pediatric-calculators"
import { getAuthUser } from "@/lib/mobile-auth"
import { canAccessCaseWithOwnerFallback } from "@/lib/access-control"
import { pediatricMutationResponse } from "@/lib/pediatric-http"
import {
  CaseWriteError,
  isCaseFinalizedDatabaseError,
  withLockedCaseTransaction,
} from "@/lib/clinical-transaction"

const calculationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("MOSTELLER_BSA"),
    inputs: z.object({
      heightCm: z.number().positive(),
      weightKg: z.number().positive(),
    }),
  }),
  z.object({
    kind: z.literal("MAINTENANCE_FLUID"),
    inputs: z.object({
      weightKg: z.number().positive(),
      age: z.object({
        value: z.number().nonnegative(),
        unit: z.enum(["DAYS", "MONTHS", "YEARS"]),
      }).nullable().optional(),
    }),
  }),
  z.object({
    kind: z.literal("RCUK_RESUSCITATION"),
    inputs: z.object({
      weightKg: z.number().positive(),
    }),
  }),
])

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const records = await withLockedCaseTransaction(id, async tx => {
    const record = await tx.case.findUnique({
      where: { id },
      select: { id: true, userId: true, institutionId: true, status: true },
    })
    if (!record) throw new CaseWriteError("CASE_NOT_FOUND", 404, "Not found")
    if (!await canAccessCaseWithOwnerFallback(tx, user, record)) {
      throw new CaseWriteError("CASE_FORBIDDEN", 403, "Forbidden")
    }
    return tx.caseClinicalCalculation.findMany({
      where: { caseId: id },
      orderBy: { createdAt: "desc" },
    })
  })
  return NextResponse.json(records)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const parsed = calculationSchema.safeParse(await req.json())
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  const { id } = await params

  try {
    const record = await withLockedCaseTransaction(id, async tx => {
      const found = await tx.case.findUnique({
        where: { id },
        select: {
          id: true,
          userId: true,
          institutionId: true,
          status: true,
          clinicalMode: true,
        },
      })
      if (!found) throw new CaseWriteError("CASE_NOT_FOUND", 404, "Not found")
      if (!await canAccessCaseWithOwnerFallback(tx, user, found)) {
        throw new CaseWriteError("CASE_FORBIDDEN", 403, "Forbidden")
      }
      if (found.status === "COMPLETE") {
        throw new CaseWriteError("CASE_FINALIZED", 403, "Case is finalised")
      }
      if (found.clinicalMode !== "PEDIATRIC") {
        throw new CaseWriteError("PEDIATRIC_CASE_REQUIRED", 409, "Pediatric case required")
      }

      const pediatricBlock = pediatricMutationResponse(req, found.clinicalMode)
      if (pediatricBlock) return pediatricBlock
      const request = parsed.data
      const result = request.kind === "MOSTELLER_BSA"
        ? calculateMostellerBsa(request.inputs)
        : request.kind === "MAINTENANCE_FLUID"
          ? calculatePediatricMaintenanceFluid(request.inputs)
          : calculateRcukPediatricResuscitation(request.inputs)
      if (!result.available) {
        throw new CaseWriteError(result.reason, 422, result.reason)
      }
      return tx.caseClinicalCalculation.create({
        data: {
          caseId: id,
          kind: request.kind,
          inputs: request.inputs,
          outputs: result.value,
          ruleVersion: result.ruleVersion,
          sourceRefs: result.sourceIds,
          acceptedBy: user.id,
          acceptedAt: new Date(),
        },
      })
    })
    if (record instanceof Response) return record
    return NextResponse.json(record, { status: 201 })
  } catch (error: unknown) {
    if (error instanceof CaseWriteError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    if (isCaseFinalizedDatabaseError(error)) {
      return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
    }
    throw error
  }
}
