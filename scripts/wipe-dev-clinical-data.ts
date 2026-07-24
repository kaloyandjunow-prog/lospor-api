/**
 * Dev-only clinical data wipe.
 *
 * Preserves users, institutions, vocabularies, option library, auth/config data,
 * and seed tables. Deletes cases and case-owned clinical data by cascade.
 *
 * Usage:
 *   $env:WIPE_DEV_CLINICAL_DATA="YES"; npx tsx scripts/wipe-dev-clinical-data.ts
 */
import "dotenv/config"
import { PrismaClient, Prisma } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

if (process.env.WIPE_DEV_CLINICAL_DATA !== "YES") {
  throw new Error('Refusing to wipe clinical data. Set WIPE_DEV_CLINICAL_DATA="YES" explicitly.')
}

if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
  throw new Error("Refusing to run clinical wipe in a production-like environment.")
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } satisfies Prisma.PrismaClientOptions)

async function main() {
  const before = await prisma.case.count()
  await prisma.$transaction([
    prisma.auditLog.deleteMany({
      where: {
        OR: [
          { action: { startsWith: "CASE" } },
          { action: { startsWith: "RELATIONAL" } },
        ],
      },
    }),
    prisma.case.deleteMany(),
  ])
  console.log(`Deleted ${before} clinical case(s). Preserved accounts, institutions, vocabularies, option libraries, and config tables.`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
