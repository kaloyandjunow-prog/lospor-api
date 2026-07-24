import { NextRequest, NextResponse, after } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { checkEventPII, piiErrorBody, type ClinicalPiiIssue } from "@/lib/clinical-pii"
import { logAudit } from "@/lib/audit"
import { addEvent, reconcileFullLog, rebuildProjection, reserveIntraopRevision, type LogEvent } from "@/lib/case-events"
import { canAccessCase } from "@/lib/access-control"
import { corsHeaders } from "@/lib/cors"
import { z } from "zod"

const CORS = (req: NextRequest) => corsHeaders(req, "POST, PUT, OPTIONS")

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

// Permissive event schema — known fields typed, unknown ones (color, infId,
// fluidId, etc.) passed through so the timetable projection still sees them.
const MAX_LOG_ENTRIES = 20_000

const eventSchema = z.object({
  id:        z.string().optional(),
  ts:        z.string().optional(),
  type:      z.string().min(1).max(64),
  name:      z.string().max(200).optional(),
  label:     z.string().max(200).optional(),
  dose:      z.union([z.string(), z.number()]).optional(),
  unit:      z.string().max(40).optional(),
  rate:      z.union([z.string(), z.number()]).optional(),
  volume:    z.union([z.string(), z.number()]).optional(),
}).passthrough()

// Free-text fields a user can type — these get the same PII guard as the rest of
// the clinical write paths. Vitals/numbers are not user prose, so they're skipped.
function piiForEvent(ev: { name?: unknown; label?: unknown }): ClinicalPiiIssue | null {
  return checkEventPII(ev)
}

const ALLOWED_SOURCES = new Set(["web", "mobile", "ai", "import"])
function sourceFrom(req: NextRequest): string {
  const s = req.headers.get("x-lospor-source") ?? ""
  if (ALLOWED_SOURCES.has(s)) return s
  // Infer from auth style when the client doesn't tag itself: the mobile app uses
  // a Bearer token, the web app uses a cookie session.
  const authz = req.headers.get("authorization") ?? ""
  return authz.startsWith("Bearer ") ? "mobile" : "web"
}

function revisionFrom(req: NextRequest): number | null | "invalid" {
  const raw = req.headers.get("x-lospor-intraop-revision")
  if (raw == null) return null
  if (!/^\d+$/.test(raw)) return "invalid"
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : "invalid"
}

async function revisionConflict(id: string) {
  const intraop = await prisma.intraoperativeRecord.findUnique({
    where: { caseId: id },
    select: { updatedAt: true, syncRevision: true },
  })
  return NextResponse.json({
    error: "conflict",
    section: "intraop",
    serverVersion: intraop
      ? { updatedAt: intraop.updatedAt, revision: intraop.syncRevision }
      : undefined,
  }, { status: 409 })
}

async function authorize(req: NextRequest, id: string) {
  const user = await getAuthUser(req)
  if (!user?.id) return { error: "Unauthorized", status: 401 as const }

  const existing = await prisma.case.findUnique({
    where: { id },
    select: {
      userId: true, status: true,
      user:    { select: { institutionId: true } },
      intraop: { select: { keyEvents: true, startTime: true, updatedAt: true, syncRevision: true } },
    },
  })
  if (!existing) return { error: "Not found", status: 404 as const }

  if (!canAccessCase(user, existing)) {
    return { error: "Forbidden", status: 403 as const }
  }

  return { user, existing }
}

// POST — append one event. The CaseEvent rows are the source of truth; the
// keyEvents cache is rebuilt from them so every existing reader is unchanged.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorize(req, id)
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { user, existing } = auth

  if (existing.status === "COMPLETE") return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
  const revision = revisionFrom(req)
  if (revision === "invalid") return NextResponse.json({ error: "Invalid intraop revision" }, { status: 400 })
  if (revision != null && existing.intraop && existing.intraop.syncRevision !== revision) {
    return revisionConflict(id)
  }

  let event: z.infer<typeof eventSchema>
  try {
    event = eventSchema.parse(await req.json())
  } catch {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 })
  }
  if (!event.id) event.id = crypto.randomUUID()

  const piiError = piiForEvent(event)
  if (piiError) {
    return NextResponse.json(piiErrorBody(piiError), { status: 400 })
  }

  // Resolve Drug.id from ATC code when a drug event arrives without one
  if (event.type === "drug" && event.atcCode && !event.drugId) {
    const drug = await prisma.drug.findFirst({ where: { atcCode: String(event.atcCode) }, select: { id: true } })
    if (drug) event.drugId = drug.id
  }

  const source = sourceFrom(req)

  for (let attempt = 0; ; attempt++) {
    try {
      // No interactive $transaction — see the identical comment in
      // case/[id]/route.ts: Supabase's Transaction-mode PgBouncer (port 6543)
      // cannot sustain interactive transactions across multiple statements
      // (P2028), which is exactly what was causing 500s here, worse under
      // load. addEvent/rebuildProjection accept a plain PrismaClient for
      // this reason (see the Tx type in case-events.ts).
      const revisionReserved = revision != null && !!existing.intraop
      if (revisionReserved && !await reserveIntraopRevision(prisma, id, revision)) {
        return revisionConflict(id)
      }
      const added = await addEvent(prisma, id, user.id, event as unknown as LogEvent, source)
      await rebuildProjection(prisma, id, { revisionAlreadyReserved: revisionReserved })

      if (existing.status === "DRAFT") {
        await prisma.case.update({ where: { id }, data: { status: "IN_PROGRESS" } })
      }
      if (added) {
        after(() => logAudit(user.id, "CASE_EVENT_ADD", id, { type: event.type, source }))
      }
      const intraop = await prisma.intraoperativeRecord.findUnique({ where: { caseId: id }, select: { updatedAt: true, syncRevision: true } })
      return NextResponse.json({
        ok: true,
        id: event.id,
        intraopUpdatedAt: intraop?.updatedAt,
        intraopRevision: intraop?.syncRevision,
      })
    } catch (e: unknown) {
      // Serialization failure (P2034) or a unique race (P2002) — retry a few times.
      if ((e && typeof e === "object" && "code" in e && (e.code === "P2034" || e.code === "P2002")) && attempt < 5) continue
      console.error("[events POST]", e)
      return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
  }
}

// PUT — the client sends its full desired log (after an edit/delete). We
// reconcile it into append-only versioned rows: changes supersede, removals
// tombstone. History is never lost.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorize(req, id)
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { user, existing } = auth
  if (existing.status === "COMPLETE") return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
  const source = sourceFrom(req)

  const body = await req.json()
  const rawLog = body?.log
  if (!Array.isArray(rawLog)) return NextResponse.json({ error: "log must be array" }, { status: 400 })
  // Individual entries were size-capped but the array itself was not, and
  // reconciling the log costs a round trip per changed event — so a client
  // could hang the function with one oversized request. The cap is far above
  // any real case: a 24-hour operation logging an event every 5 seconds would
  // still fit inside it several times over.
  if (rawLog.length > MAX_LOG_ENTRIES) {
    return NextResponse.json(
      { error: `log too large (${rawLog.length} entries, maximum ${MAX_LOG_ENTRIES})` },
      { status: 413 },
    )
  }
  const intraopBase = req.headers.get("x-lospor-intraop-updated-at")
  const revisionRaw = req.headers.get("x-lospor-intraop-revision")
  const intraopRevision = revisionRaw == null
    ? null
    : /^\d+$/.test(revisionRaw) && Number.isSafeInteger(Number(revisionRaw))
      ? Number(revisionRaw)
      : "invalid"
  if (intraopRevision === "invalid") {
    return NextResponse.json({ error: "Invalid intraop revision" }, { status: 400 })
  }
  if (intraopBase && Number.isNaN(new Date(intraopBase).getTime())) {
    return NextResponse.json({ error: "Invalid intraop conflict timestamp" }, { status: 400 })
  }
  if (intraopRevision == null && !intraopBase && existing.intraop?.updatedAt) {
    return NextResponse.json({
      error: "conflict",
      section: "intraop",
      reason: "missing_conflict_timestamp",
      serverVersion: { updatedAt: existing.intraop.updatedAt, revision: existing.intraop.syncRevision },
    }, { status: 409 })
  }
  if (intraopRevision != null && existing.intraop && existing.intraop.syncRevision !== intraopRevision) {
    return NextResponse.json({
      error: "conflict",
      section: "intraop",
      serverVersion: { updatedAt: existing.intraop.updatedAt, revision: existing.intraop.syncRevision },
    }, { status: 409 })
  }
  if (intraopRevision == null && intraopBase && existing.intraop?.updatedAt && existing.intraop.updatedAt.getTime() > new Date(intraopBase).getTime()) {
    return NextResponse.json({ error: "conflict", section: "intraop", serverVersion: { updatedAt: existing.intraop.updatedAt, revision: existing.intraop.syncRevision } }, { status: 409 })
  }

  // Validate + PII-check every entry before it becomes the working set.
  let log: z.infer<typeof eventSchema>[]
  try {
    log = rawLog.map(e => eventSchema.parse(e))
  } catch {
    return NextResponse.json({ error: "Invalid event in log" }, { status: 400 })
  }
  for (const ev of log) {
    const piiError = piiForEvent(ev)
    if (piiError) {
      return NextResponse.json(piiErrorBody(piiError), { status: 400 })
    }
  }

  for (let attempt = 0; ; attempt++) {
    try {
      // No interactive $transaction — same PgBouncer constraint as POST above.
      // reconcileFullLog's reconcile-then-tombstone sequence is the heaviest
      // statement sequence in this file (one round trip per changed/removed
      // event), so it was the most likely to hit P2028 — this is what was
      // actually causing the 500 on event removal specifically. The
      // check-then-write conflict window this opens is the same accepted
      // trade-off documented in case/[id]/route.ts.
      if (intraopBase || intraopRevision != null) {
        if (intraopRevision != null && existing.intraop) {
          if (!await reserveIntraopRevision(prisma, id, intraopRevision)) throw new Error("INTRAOP_CONFLICT")
        } else {
          const fresh = await prisma.intraoperativeRecord.findUnique({ where: { caseId: id }, select: { updatedAt: true } })
          if (intraopBase && fresh?.updatedAt && fresh.updatedAt.getTime() > new Date(intraopBase).getTime()) {
            throw new Error("INTRAOP_CONFLICT")
          }
        }
      }
      await reconcileFullLog(prisma, id, user.id, log as unknown as LogEvent[], source)
      await rebuildProjection(prisma, id, { revisionAlreadyReserved: intraopRevision != null && !!existing.intraop })

      after(() => logAudit(user.id, "CASE_EVENT_EDIT", id, { count: log.length, source }))
      const intraop = await prisma.intraoperativeRecord.findUnique({ where: { caseId: id }, select: { updatedAt: true, syncRevision: true } })
      return NextResponse.json({
        ok: true,
        intraopUpdatedAt: intraop?.updatedAt,
        intraopRevision: intraop?.syncRevision,
      })
    } catch (e: unknown) {
      if (e instanceof Error && e.message === "INTRAOP_CONFLICT") {
        const intraop = await prisma.intraoperativeRecord.findUnique({ where: { caseId: id }, select: { updatedAt: true, syncRevision: true } })
        return NextResponse.json({
          error: "conflict",
          section: "intraop",
          serverVersion: intraop?.updatedAt ? { updatedAt: intraop.updatedAt, revision: intraop.syncRevision } : undefined,
        }, { status: 409 })
      }
      if ((e && typeof e === "object" && "code" in e && (e.code === "P2034" || e.code === "P2002")) && attempt < 5) continue
      console.error("[events PUT]", e)
      return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
  }
}
