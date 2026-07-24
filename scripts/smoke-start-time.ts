/**
 * Start/end time smoke test — the real HTTP path against a running server.
 *
 *   npm run smoke:start-time
 *   BASE_URL=http://192.168.0.105:3000 npm run smoke:start-time
 *
 * Guards two defects that shared one cause — a column that could not express
 * "not started yet":
 *
 *   1. The first intraop autosave fires on any watched field (a monitoring
 *      checkbox is enough), long before Timing is touched. That save used to
 *      write a midnight sentinel into startTime. A JS Date is always truthy, so
 *      the form then rendered a locked "00:00" badge with no way back, and the
 *      finalise guard that checks `!startTime` could never fire.
 *
 *   2. Start times are the clinician's local wall clock; events are real
 *      instants. Storing the former with no timezone meant the two could not be
 *      compared, putting the chart origin an offset out.
 *
 * Exits non-zero on the first failure so it can gate a release.
 */
import { E2E_EMAIL, E2E_PASSWORD } from "../e2e/credentials"
import {
  buildIntraopStartTiming,
  startInstantForWallClock,
} from "@lospor/core/intraop-time"

const BASE = (process.env.BASE_URL ?? "http://localhost:3002").replace(/\/$/, "")

let failures = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`)
  }
}

async function main() {
  console.log(`Start-time smoke test against ${BASE}\n`)

  const tokenRes = await fetch(`${BASE}/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: E2E_EMAIL, password: E2E_PASSWORD }),
  })
  if (!tokenRes.ok) {
    console.error(`Could not authenticate (${tokenRes.status}). Run: npx tsx scripts/seed-e2e-user.ts`)
    process.exit(1)
  }
  const { access_token: token } = await tokenRes.json() as { access_token: string }
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` }

  // ── Create a case ──────────────────────────────────────────────────────────
  const createRes = await fetch(`${BASE}/v1/cases`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ preop: { ageYears: 40, sex: "MALE", heightCm: 176, weightKg: 70 } }),
  })
  check("case created", createRes.ok, await createRes.clone().text().catch(() => createRes.status))
  if (!createRes.ok) process.exit(1)
  const { id: caseId } = await createRes.json() as { id: string }

  const readIntraop = async () => {
    const res = await fetch(`${BASE}/v1/cases/${caseId}`, { headers: auth })
    const body = await res.json() as { intraop?: Record<string, unknown> | null }
    return body.intraop ?? null
  }

  // ── 1. The reported bug ────────────────────────────────────────────────────
  // Save an intraop field that has nothing to do with Timing.
  const patch1 = await fetch(`${BASE}/v1/cases/${caseId}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ intraop: { ecg: true, timezone: "Europe/Sofia" } }),
  })
  check("non-Timing intraop field saves", patch1.ok, patch1.status)

  const afterUnrelated = await readIntraop()
  check("startTime is not invented by an unrelated save",
        afterUnrelated?.startTime == null, afterUnrelated?.startTime)
  check("startedAt is not invented either",
        afterUnrelated?.startedAt == null, afterUnrelated?.startedAt)

  // ── 2. A real start time, in local wall clock ──────────────────────────────
  const startInstant = startInstantForWallClock(new Date(), "08:00", "Europe/Sofia")
  const timing = startInstant
    ? buildIntraopStartTiming(startInstant, "Europe/Sofia")
    : null
  if (!timing) throw new Error("Could not build start timing.")
  const patch2 = await fetch(`${BASE}/v1/cases/${caseId}`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ intraop: timing }),
  })
  check("start time saves", patch2.ok, patch2.status)

  const started = await readIntraop()
  check("legacy wall clock still recorded",
        typeof started?.startTime === "string" && /T08:00:00/.test(started.startTime as string),
        started?.startTime)
  check("exact start instant recorded", started?.startedAt === timing.startedAt, started?.startedAt)
  check("timezone recorded", started?.timezone === "Europe/Sofia", started?.timezone)

  if (typeof started?.startedAt === "string") {
    // 08:00 in Sofia is 05:00 UTC in summer, 06:00 in winter — assert it is one
    // of those rather than the naive 08:00Z the old code would have produced.
    const hourUtc = new Date(started.startedAt).getUTCHours()
    check("instant is offset-corrected, not stored as if UTC",
          hourUtc === 5 || hourUtc === 6, `${started.startedAt} (UTC hour ${hourUtc})`)
  }

  // ── 3. A later unrelated save must not disturb it ──────────────────────────
  await fetch(`${BASE}/v1/cases/${caseId}`, {
    method: "PATCH", headers: auth,
    body: JSON.stringify({ intraop: { tempMonitor: true, timezone: "Europe/Sofia" } }),
  })
  const afterLater = await readIntraop()
  check("a later unrelated save leaves the start time alone",
        afterLater?.startTime === started?.startTime && afterLater?.startedAt === started?.startedAt,
        { before: started?.startedAt, after: afterLater?.startedAt })

  // ── 4. A malformed time must not erase a stored one ────────────────────────
  await fetch(`${BASE}/v1/cases/${caseId}`, {
    method: "PATCH", headers: auth,
    body: JSON.stringify({ intraop: { startTime: "", timezone: "Europe/Sofia" } }),
  })
  const afterBlank = await readIntraop()
  check("an empty start time does not erase the stored one",
        afterBlank?.startedAt === started?.startedAt, afterBlank?.startedAt)

  // ── Clean up ───────────────────────────────────────────────────────────────
  await fetch(`${BASE}/v1/cases/${caseId}`, { method: "DELETE", headers: auth })

  console.log(failures === 0 ? "\nStart-time behaviour OK" : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
