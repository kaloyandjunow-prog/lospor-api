/**
 * Autosave smoke test — exercises the real HTTP path against a running server.
 *
 *   npm run smoke:autosave                  # defaults to http://localhost:3002
 *   BASE_URL=http://192.168.0.105:3002 npm run smoke:autosave
 *
 * Unit tests cover the parser and the mapper in isolation; this covers the wire:
 * auth → create → PATCH → read back. It guards the two failures that shipped
 * together in v5.2.0:
 *
 *   1. one out-of-range value 400'd the whole request, discarding every other
 *      edit in that autosave;
 *   2. a field-level PATCH nulled every field it did not mention.
 *
 * Exits non-zero on the first failure so it can gate a release.
 */
import { E2E_EMAIL, E2E_PASSWORD } from "../e2e/credentials"

const BASE = (process.env.BASE_URL ?? "http://localhost:3002").replace(/\/$/, "")

let failures = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`)
  }
}

async function main() {
  console.log(`Autosave smoke test against ${BASE}\n`)

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
  const auth = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }

  const created = await fetch(`${BASE}/v1/cases`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ preop: { ageYears: 40, sex: "MALE", heightCm: 176, weightKg: 70 } }),
  })
  const createdCase = await created.json() as { id: string; preopRevision?: number }
  const { id } = createdCase
  let preopRevision = createdCase.preopRevision
  if (!id) { console.error("Could not create a test case"); process.exit(1) }
  console.log(`test case ${id}\n`)

  const patch = async (preop: Record<string, unknown>) => {
    const res = await fetch(`${BASE}/v1/cases/${id}`, {
      method: "PATCH",
      headers: {
        ...auth,
        ...(preopRevision != null ? { "x-lospor-preop-revision": String(preopRevision) } : {}),
      },
      body: JSON.stringify({ preop }),
    })
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    if (typeof body.preopRevision === "number") preopRevision = body.preopRevision
    return { status: res.status, body }
  }
  const read = async () => {
    const res = await fetch(`${BASE}/v1/cases/${id}`, { headers: auth })
    const j = await res.json() as { preop?: Record<string, unknown> }
    return j.preop ?? {}
  }

  // ── 1. a value the API rejects must not sink the rest of the save ─────────
  console.log("A partially-invalid save keeps the valid fields")
  const bad = await patch({ heightCm: 17, weightKg: 82, ageYears: 51 })
  check("returns 200, not 400", bad.status === 200, bad.status)
  check("names the rejected field", JSON.stringify(bad.body.rejectedFields ?? "").includes("heightCm"), bad.body.rejectedFields)
  let preop = await read()
  check("valid weight persisted", preop.weightKg === 82, preop.weightKg)
  check("valid age persisted", preop.ageYears === 51, preop.ageYears)
  check("rejected height did NOT overwrite the stored value", preop.heightCm === 176, preop.heightCm)

  // ── 2. a diff patch must not erase what it does not mention ───────────────
  console.log("\nA field-level patch leaves unmentioned fields alone")
  await patch({ heightCm: 180, weightKg: 75, ageYears: 44 })
  const onlyWeight = await patch({ weightKg: 99 })
  check("returns 200", onlyWeight.status === 200, onlyWeight.status)
  preop = await read()
  check("weight updated", preop.weightKg === 99, preop.weightKg)
  check("height preserved", preop.heightCm === 180, preop.heightCm)
  check("age preserved", preop.ageYears === 44, preop.ageYears)

  // ── 3. a typo must be refused, not silently written as "cleared" ──────────
  console.log("\nAn unparseable value is refused, not stored as blank")
  await patch({ heightCm: 178, weightKg: 75 })
  const typo = await patch({ heightCm: "12abc", weightKg: 76 })
  check("returns 200", typo.status === 200, typo.status)
  check("reports the typo as rejected", JSON.stringify(typo.body.rejectedFields ?? "").includes("heightCm"), typo.body.rejectedFields)
  preop = await read()
  check("stored height survived the typo", preop.heightCm === 178, preop.heightCm)
  check("the valid field alongside it still saved", preop.weightKg === 76, preop.weightKg)

  // ── 4. clearing a field on purpose must still work ────────────────────────
  console.log("\nExplicitly clearing a field still stores null")
  await patch({ heightCm: null })
  preop = await read()
  check("height cleared to null", preop.heightCm === null, preop.heightCm)
  // 76, not 99: the typo check above deliberately saved a new weight alongside
  // the rejected height. This expectation was left at 99 when that step was
  // added, so it failed for the right reason on the wrong value — the point
  // being tested is that clearing height leaves weight alone, whatever it is.
  check("weight untouched by the clear", preop.weightKg === 76, preop.weightKg)

  // ── 5. a clean save reports nothing ───────────────────────────────────────
  console.log("\nA fully valid save reports no rejections")
  const good = await patch({ heightCm: 181, weightKg: 83 })
  check("returns 200", good.status === 200, good.status)
  check("no rejectedFields key", good.body.rejectedFields === undefined, good.body.rejectedFields)

  console.log("\nEvent append/edit/delete uses one advancing intraop revision")
  const eventId = `smoke-event-${Date.now()}`
  const appendEvent = await fetch(`${BASE}/v1/cases/${id}/events`, {
    method: "POST",
    headers: { ...auth, "x-lospor-idempotency-key": `${id}:${eventId}` },
    body: JSON.stringify({ id: eventId, type: "clinical_event", label: "Smoke event", ts: new Date().toISOString() }),
  })
  const appendBody = await appendEvent.json().catch(() => ({})) as Record<string, unknown>
  let intraopRevision = typeof appendBody.intraopRevision === "number" ? appendBody.intraopRevision : undefined
  check("event append succeeds", appendEvent.ok && intraopRevision != null, appendBody)

  const editEvent = await fetch(`${BASE}/v1/cases/${id}/events/${eventId}`, {
    method: "PUT",
    headers: {
      ...auth,
      ...(intraopRevision != null ? { "x-lospor-intraop-revision": String(intraopRevision) } : {}),
    },
    body: JSON.stringify({ type: "clinical_event", label: "Smoke event edited", ts: new Date().toISOString() }),
  })
  const editBody = await editEvent.json().catch(() => ({})) as Record<string, unknown>
  if (typeof editBody.intraopRevision === "number") intraopRevision = editBody.intraopRevision
  check("targeted event edit succeeds", editEvent.ok, editBody)

  const deleteEvent = await fetch(`${BASE}/v1/cases/${id}/events/${eventId}`, {
    method: "DELETE",
    headers: {
      ...auth,
      ...(intraopRevision != null ? { "x-lospor-intraop-revision": String(intraopRevision) } : {}),
    },
  })
  const deleteBody = await deleteEvent.json().catch(() => ({})) as Record<string, unknown>
  check("targeted event delete succeeds", deleteEvent.ok, deleteBody)

  // ── 6. creating a case with one bad field must not lose the rest ──────────
  //
  // The reported failure: the web height picker allowed 12 cm, POST /v1/cases
  // validated strictly, the whole request 400'd, and no case row was written —
  // so leaving the screen destroyed the entire assessment. Create is now
  // lenient like PATCH.
  console.log("\nA bad field on create refuses the field, not the case")
  const created2 = await fetch(`${BASE}/v1/cases`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ preop: { ageYears: 40, sex: "MALE", heightCm: 12, weightKg: 70, diagnosis: "Smoke test" } }),
  })
  check("create still succeeds", created2.ok, created2.status)
  const createdBody = await created2.json().catch(() => ({})) as Record<string, unknown>
  const id2 = createdBody.id as string | undefined
  check("a case was actually created", !!id2, createdBody)
  check("the bad height is reported back",
        JSON.stringify(createdBody.rejectedFields ?? "").includes("heightCm"), createdBody.rejectedFields)

  if (id2) {
    const res2 = await fetch(`${BASE}/v1/cases/${id2}`, { headers: auth })
    const body2 = await res2.json() as { preop?: Record<string, unknown> }
    check("the out-of-range height was not stored", body2.preop?.heightCm == null, body2.preop?.heightCm)
    check("everything else in the same save survived",
          body2.preop?.weightKg === 70 && body2.preop?.ageYears === 40,
          { weightKg: body2.preop?.weightKg, ageYears: body2.preop?.ageYears })
    await fetch(`${BASE}/v1/cases/${id2}`, { method: "DELETE", headers: auth }).catch(() => {})
  }

  await fetch(`${BASE}/v1/cases/${id}`, { method: "DELETE", headers: auth }).catch(() => {})

  console.log(failures === 0 ? "\nAll autosave smoke checks passed." : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
