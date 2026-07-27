import { prisma } from "@/lib/prisma"
import { processResearchExport } from "@/lib/research/exports"

function requestedLimit(): number {
  const argument = process.argv.find(value => value.startsWith("--limit="))?.split("=")[1]
  const parsed = Number.parseInt(argument ?? process.env.RESEARCH_EXPORT_WORKER_BATCH_SIZE ?? "10", 10)
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 10
}

async function main() {
  const ids: string[] = []
  let failed = 0
  for (let index = 0; index < requestedLimit(); index += 1) {
    try {
      const record = await processResearchExport()
      if (!record) break
      ids.push(record.id)
    } catch (error) {
      failed += 1
      console.error("Research export job failed", error)
    }
  }
  console.log(JSON.stringify({ processed: ids.length, failed, ids }, null, 2))
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
