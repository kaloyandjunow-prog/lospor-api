import "dotenv/config"
import { PrismaClient, Prisma } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter } satisfies Prisma.PrismaClientOptions)

async function main() {
  const institutions = [
    { name: "УМБАЛ Александровска", city: "Sofia" },
    { name: "УМБАЛ Света Екатерина", city: "Sofia" },
    { name: "УМБАЛ Царица Йоанна - ИСУЛ", city: "Sofia" },
    { name: "УМБАЛ Св. Иван Рилски", city: "Sofia" },
    { name: "Национална кардиологична болница", city: "Sofia" },
    { name: "УМБАЛ Георги Странски", city: "Pleven" },
    { name: "УМБАЛ Свети Георги", city: "Plovdiv" },
    { name: "МБАЛ Пловдив", city: "Plovdiv" },
    { name: "УМБАЛ Св. Марина", city: "Varna" },
    { name: "МБАЛ Варна", city: "Varna" },
    { name: "УМБАЛ Проф. Д-р Стоян Киркович", city: "Stara Zagora" },
    { name: "МБАЛ Бургас", city: "Burgas" },
    { name: "МБАЛ Велико Търново", city: "Veliko Tarnovo" },
    { name: "Other / Test institution", city: "Bulgaria" },
  ]

  await prisma.institution.createMany({
    data: institutions.map(inst => ({ name: inst.name, city: inst.city, country: "Bulgaria" })),
    skipDuplicates: true,
  })

  console.log(`Seeded ${institutions.length} institutions`)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
