import { Prisma, PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const DEFAULT_MAX_WAIT_MS = 10_000
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_DIRECT_POOL_SIZE = 3

type DirectTransactionOptions = {
  isolationLevel?: Prisma.TransactionIsolationLevel
  maxWait?: number
  timeout?: number
}

type ClinicalGlobal = typeof globalThis & {
  __losporClinicalPrisma?: PrismaClient
}

function directConnectionString(): string {
  const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL
  if (!connectionString) throw new Error("DIRECT_URL or DATABASE_URL is required")
  return connectionString
}

function directPoolSize(): number {
  const configured = Number.parseInt(
    process.env.CLINICAL_TRANSACTION_POOL_SIZE ?? String(DEFAULT_DIRECT_POOL_SIZE),
    10,
  )
  if (!Number.isFinite(configured)) return DEFAULT_DIRECT_POOL_SIZE
  return Math.min(10, Math.max(2, configured))
}

export function clinicalPrisma(): PrismaClient {
  const shared = globalThis as ClinicalGlobal
  if (!shared.__losporClinicalPrisma) {
    const adapter = new PrismaPg({
      connectionString: directConnectionString(),
      // At least two connections are required for real concurrent row-lock
      // waits. The upper bound remains deliberately small for serverless use.
      max: directPoolSize(),
    })
    shared.__losporClinicalPrisma = new PrismaClient({ adapter } satisfies Prisma.PrismaClientOptions)
  }
  return shared.__losporClinicalPrisma
}

export async function withDirectTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  options: DirectTransactionOptions = {},
): Promise<T> {
  return clinicalPrisma().$transaction(operation, {
    isolationLevel: options.isolationLevel ?? "ReadCommitted",
    maxWait: options.maxWait ?? DEFAULT_MAX_WAIT_MS,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
  })
}

export async function lockCaseForUpdate(
  tx: Prisma.TransactionClient,
  caseId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Case"
    WHERE "id" = ${caseId}
    FOR UPDATE
  `
  return rows.length === 1
}

export async function withLockedCaseTransaction<T>(
  caseId: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  options: DirectTransactionOptions = {},
): Promise<T> {
  return withDirectTransaction(async tx => {
    if (!await lockCaseForUpdate(tx, caseId)) {
      throw new CaseWriteError("CASE_NOT_FOUND", 404, "Case not found")
    }
    return operation(tx)
  }, options)
}

export class CaseWriteError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function isCaseFinalizedDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes("CASE_FINALIZED")
}

export async function disconnectClinicalPrismaForTests(): Promise<void> {
  const shared = globalThis as ClinicalGlobal
  if (!shared.__losporClinicalPrisma) return
  await shared.__losporClinicalPrisma.$disconnect()
  delete shared.__losporClinicalPrisma
}
