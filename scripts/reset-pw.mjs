import bcrypt from "bcryptjs"
import { PrismaClient } from "../src/generated/prisma/client/index.js"

const prisma = new PrismaClient()
const hash = await bcrypt.hash("Lospor77!", 12)
const r = await prisma.user.updateMany({
  where: { email: { in: ["kaloyandjunow@gmail.com", "admin@lospor.bg"] } },
  data: { passwordHash: hash },
})
console.log("Reset password for", r.count, "users")
await prisma.$disconnect()
