import "dotenv/config"
import { PrismaClient, Prisma } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { NO_INSTITUTION } from "../src/lib/institutions"
import { provisionBundledClinicalBaselines } from "../src/lib/clinical-rules/bundled-baseline-provisioner"

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

  // Registration requires an institution, so there has to be something to pick
  // when none of the real ones apply. Upserted on a fixed id: the rules that
  // stop it having a head of department key on that id, and re-seeding must
  // not mint a second one under a new cuid.
  await prisma.institution.upsert({
    where:  { id: NO_INSTITUTION.id },
    update: { name: NO_INSTITUTION.name, city: NO_INSTITUTION.city },
    create: { ...NO_INSTITUTION },
  })

  const baselines = await provisionBundledClinicalBaselines(prisma)

  console.log(`Seeded ${institutions.length} institutions, plus ${NO_INSTITUTION.name}`)
  console.log(`Bundled clinical baselines: ${baselines.outcome} (${baselines.baselines.map(item => `${item.clinicalMode} ${item.ruleCount}`).join(", ")})`)
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
