import "dotenv/config"
import { PrismaPg } from "@prisma/adapter-pg"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { provisionBundledClinicalBaselines } from "../src/lib/clinical-rules/bundled-baseline-provisioner"

async function main(): Promise<void> {
  if (process.argv.slice(2).join(" ") !== "--apply") {
    throw new Error(
      "Refusing to write without explicit --apply. Usage: npm run clinical-rules:provision-bundled-baselines -- --apply",
    )
  }
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  } satisfies Prisma.PrismaClientOptions)
  try {
    const result = await provisionBundledClinicalBaselines(prisma)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
