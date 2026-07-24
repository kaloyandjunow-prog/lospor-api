import "dotenv/config"
import { INTRAOP_COLUMN_MS } from "@lospor/core/intraop-engine"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { rebuildProjection } from "../src/lib/case-events"

type Candidate = {
  caseId: string
  caseCode: string
  rowId: string
  logicalId: string
  timestamp: string
  matchingRowId: string
  matchingLogicalId: string
  matchingTimestamp: string
  offsetMinutes: number
  reason: "future" | "after_case_end" | "future_and_after_case_end"
  signature: string
}

type Manifest = {
  schemaVersion: 1
  generatedAt: string
  dryRun: true
  candidates: Candidate[]
}

const adapter = new PrismaPg({
  connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
})
const prisma = new PrismaClient({ adapter })

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? null : null
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stable((value as Record<string, unknown>)[key])
      return result
    }, {} as Record<string, unknown>)
  }
  return value
}

function clinicalSignature(value: unknown): string {
  const event = value && typeof value === "object"
    ? { ...(value as Record<string, unknown>) }
    : {}
  for (const key of ["id", "ts", "sequence", "syncStatus"]) delete event[key]
  return JSON.stringify(stable(event))
}

function zoneOffsetMinutes(instant: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant)
    const values: Record<string, number> = {}
    for (const part of parts) {
      if (part.type !== "literal") values[part.type] = Number(part.value)
    }
    return Math.round((
      Date.UTC(
        values.year,
        values.month - 1,
        values.day,
        values.hour,
        values.minute,
        values.second,
      ) - instant.getTime()
    ) / 60_000)
  } catch {
    return null
  }
}

async function buildManifest(now = new Date()): Promise<Manifest> {
  const cases = await prisma.case.findMany({
    where: { intraop: { isNot: null } },
    select: {
      id: true,
      caseCode: true,
      intraop: {
        select: { endedAt: true, timezone: true },
      },
      events: {
        where: { status: "active" },
        select: {
          id: true,
          logicalId: true,
          timestamp: true,
          metadataJson: true,
          source: true,
        },
        orderBy: { timestamp: "asc" },
      },
    },
  })

  const candidates: Candidate[] = []
  const futureLimit = now.getTime() + INTRAOP_COLUMN_MS

  for (const item of cases) {
    const timezone = item.intraop?.timezone
    if (!timezone) continue
    const endedLimit = item.intraop?.endedAt
      ? item.intraop.endedAt.getTime() + INTRAOP_COLUMN_MS
      : null

    for (const suspect of item.events) {
      const synthetic =
        suspect.source === "backfill" ||
        suspect.logicalId.startsWith("seed-") ||
        suspect.logicalId.startsWith("web-vital-")
      if (!synthetic) continue

      const afterNow = suspect.timestamp.getTime() > futureLimit
      const afterEnd = endedLimit !== null && suspect.timestamp.getTime() > endedLimit
      if (!afterNow && !afterEnd) continue

      const expectedOffset = zoneOffsetMinutes(suspect.timestamp, timezone)
      if (!expectedOffset) continue
      const signature = clinicalSignature(suspect.metadataJson)
      const matching = item.events.find(previous => {
        if (previous.id === suspect.id) return false
        if (previous.timestamp >= suspect.timestamp) return false
        if (clinicalSignature(previous.metadataJson) !== signature) return false
        const difference = Math.round(
          (suspect.timestamp.getTime() - previous.timestamp.getTime()) / 60_000,
        )
        return difference === Math.abs(expectedOffset)
      })
      if (!matching) continue

      candidates.push({
        caseId: item.id,
        caseCode: item.caseCode ?? item.id,
        rowId: suspect.id,
        logicalId: suspect.logicalId,
        timestamp: suspect.timestamp.toISOString(),
        matchingRowId: matching.id,
        matchingLogicalId: matching.logicalId,
        matchingTimestamp: matching.timestamp.toISOString(),
        offsetMinutes: Math.abs(expectedOffset),
        reason: afterNow && afterEnd
          ? "future_and_after_case_end"
          : afterNow
            ? "future"
            : "after_case_end",
        signature,
      })
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    dryRun: true,
    candidates,
  }
}

async function applyManifest(path: string): Promise<void> {
  const manifest = JSON.parse(await readFile(resolve(path), "utf8")) as Manifest
  if (manifest.schemaVersion !== 1 || manifest.dryRun !== true || !Array.isArray(manifest.candidates)) {
    throw new Error("Invalid anomaly manifest.")
  }

  const byCase = new Map<string, Candidate[]>()
  for (const candidate of manifest.candidates) {
    const existing = byCase.get(candidate.caseId) ?? []
    existing.push(candidate)
    byCase.set(candidate.caseId, existing)
  }

  let repaired = 0
  for (const [caseId, candidates] of byCase) {
    await prisma.$transaction(async tx => {
      for (const candidate of candidates) {
        const [suspect, matching] = await Promise.all([
          tx.caseEvent.findUnique({ where: { id: candidate.rowId } }),
          tx.caseEvent.findUnique({ where: { id: candidate.matchingRowId } }),
        ])
        const stillMatches =
          suspect?.caseId === caseId &&
          matching?.caseId === caseId &&
          suspect.status === "active" &&
          matching.status === "active" &&
          suspect.logicalId === candidate.logicalId &&
          matching.logicalId === candidate.matchingLogicalId &&
          suspect.timestamp.toISOString() === candidate.timestamp &&
          matching.timestamp.toISOString() === candidate.matchingTimestamp &&
          clinicalSignature(suspect.metadataJson) === candidate.signature &&
          clinicalSignature(matching.metadataJson) === candidate.signature
        if (!stillMatches) {
          throw new Error(`Candidate ${candidate.rowId} changed after review; nothing was applied.`)
        }

        await tx.caseEvent.update({
          where: { id: candidate.rowId },
          data: { status: "deleted" },
        })
        await tx.auditLog.create({
          data: {
            userId: "system",
            action: "INTRAOP_TIME_ANOMALY_REPAIRED",
            entityId: caseId,
            detail: {
              rowId: candidate.rowId,
              logicalId: candidate.logicalId,
              matchedRowId: candidate.matchingRowId,
              offsetMinutes: candidate.offsetMinutes,
              manifestGeneratedAt: manifest.generatedAt,
            },
          },
        })
        repaired++
      }
      await rebuildProjection(tx, caseId)
    })
  }
  console.log(`Tombstoned ${repaired} reviewed event(s) across ${byCase.size} case(s).`)
}

async function main() {
  const apply = process.argv.includes("--apply")
  if (apply) {
    const manifestPath = option("--manifest")
    if (!manifestPath) {
      throw new Error("Repair requires --manifest <reviewed-report.json>.")
    }
    await applyManifest(manifestPath)
    return
  }

  const manifest = await buildManifest()
  const output = option("--output")
  if (output) {
    const target = resolve(output)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    console.log(`Dry-run report written to ${target}`)
  } else {
    console.log(JSON.stringify(manifest, null, 2))
  }
  console.log(`${manifest.candidates.length} candidate event(s); no data changed.`)
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
