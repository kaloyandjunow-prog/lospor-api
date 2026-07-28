import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { cleanupResearchExportArtifacts, processResearchExport } from "@/lib/research/exports"

function configuredSecrets(): string[] {
  return [
    process.env.RESEARCH_EXPORT_WORKER_SECRET,
    process.env.CRON_SECRET,
  ].filter((secret): secret is string => Boolean(secret))
}

function matchesSecret(presented: string, secret: string): boolean {
  const expectedBytes = Buffer.from(secret)
  const presentedBytes = Buffer.from(presented)
  return expectedBytes.length === presentedBytes.length
    && timingSafeEqual(expectedBytes, presentedBytes)
}

function authorized(request: Request, secrets: string[]): boolean {
  const header = request.headers.get("authorization")
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : ""
  return secrets.some(secret => matchesSecret(presented, secret))
}

function batchSize(): number {
  const configured = Number.parseInt(process.env.RESEARCH_EXPORT_WORKER_BATCH_SIZE ?? "10", 10)
  if (!Number.isFinite(configured)) return 10
  return Math.min(25, Math.max(1, configured))
}

async function processNext(request: Request) {
  const secrets = configuredSecrets()
  if (secrets.length === 0) {
    return NextResponse.json(
      { error: "Research export worker is not configured", code: "WORKER_NOT_CONFIGURED" },
      { status: 503 },
    )
  }
  if (!authorized(request, secrets)) {
    return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 })
  }
  try {
    const cleanup = await cleanupResearchExportArtifacts(batchSize() * 10)
    const ids: string[] = []
    let failed = 0
    for (let index = 0; index < batchSize(); index += 1) {
      try {
        const record = await processResearchExport()
        if (!record) break
        ids.push(record.id)
      } catch (error) {
        failed += 1
        console.error("[LOSPOR] research export job failed", error)
      }
    }
    return NextResponse.json({ processed: ids.length, failed, ids, cleanup })
  } catch (error) {
    console.error("[LOSPOR] research export worker failed", error)
    return NextResponse.json(
      { error: "Research export processing failed", code: "RESEARCH_EXPORT_PROCESSING_FAILED" },
      { status: 500 },
    )
  }
}

export async function GET(request: Request) {
  return processNext(request)
}

export async function POST(request: Request) {
  return processNext(request)
}
export const dynamic = "force-dynamic"
export const maxDuration = 300
