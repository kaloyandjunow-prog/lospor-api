// Sets a new password for the accounts you name, on whichever database DATABASE_URL points at.
//
//   RESET_PASSWORD='a-new-strong-password' node scripts/reset-pw.mjs someone@example.org other@example.org
//
// Nothing here is a default: the password comes from the environment and the accounts from the command
// line, so no password or address is ever written into the repository.
import bcrypt from "bcryptjs"
import { PrismaClient } from "../src/generated/prisma/client/index.js"

const password = process.env.RESET_PASSWORD
const emails = process.argv.slice(2).map(email => email.trim().toLowerCase()).filter(Boolean)
if (!password || password.length < 12 || emails.length === 0) {
  console.error("Usage: RESET_PASSWORD='<at least 12 characters>' node scripts/reset-pw.mjs <email> [<email> ...]")
  process.exit(1)
}

const prisma = new PrismaClient()
const hash = await bcrypt.hash(password, 12)
const result = await prisma.user.updateMany({ where: { email: { in: emails } }, data: { passwordHash: hash } })
console.log("Reset password for", result.count, "users")
await prisma.$disconnect()
