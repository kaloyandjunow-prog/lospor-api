import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { logAudit } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { seedOptionLibrary } from "../../../../../../scripts/seed-option-library"

// Production maintenance action, not a casual "hit this URL to seed"
// endpoint: requires ADMIN role AND the ALLOW_MAINTENANCE_SEED=true env
// flag, so it's a no-op in any environment where that flag isn't explicitly
// set, even for an admin. Re-runs the exact same upsert logic as
// `npx tsx scripts/seed-option-library.ts` (idempotent, upsert-on-unique-key)
// — this exists so a deployed environment's option-library content can be
// refreshed without shell access to the database. Audit-logged either way.
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!requireRole(user, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  if (process.env.ALLOW_MAINTENANCE_SEED !== "true") {
    await logAudit(user.id, "maintenance.seed_option_library.blocked", "OptionLibrary", {
      reason: "ALLOW_MAINTENANCE_SEED not set to true",
    })
    return NextResponse.json({ error: "Maintenance seeding is disabled in this environment" }, { status: 403 })
  }

  try {
    const { totalRows } = await seedOptionLibrary(prisma)
    await logAudit(user.id, "maintenance.seed_option_library.success", "OptionLibrary", { totalRows })
    return NextResponse.json({ ok: true, totalRows })
  } catch (err) {
    await logAudit(user.id, "maintenance.seed_option_library.error", "OptionLibrary", {
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: "Seeding failed" }, { status: 500 })
  }
}
