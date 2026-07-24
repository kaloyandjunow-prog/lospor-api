import "dotenv/config"
import { PrismaClient, Prisma } from "../src/generated/prisma/client"
import { PrismaPg }     from "@prisma/adapter-pg"

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } satisfies Prisma.PrismaClientOptions)
  const total      = await prisma.case.count()
  const demo       = await prisma.case.count({ where: { notes: "__DEMO__" } })
  const complete   = await prisma.case.count({ where: { status: "COMPLETE" } })
  const inProgress = await prisma.case.count({ where: { status: "IN_PROGRESS" } })
  console.log(`Total: ${total} | Real: ${total - demo} | Demo: ${demo} | Complete: ${complete} | In progress: ${inProgress}`)
  await prisma.$disconnect()
}
main().catch(console.error)
