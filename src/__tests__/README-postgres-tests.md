# The `*-postgres.test.ts` files

Four test files are gated behind `LOSPOR_POSTGRES_INTEGRATION=true`:

| File | What it guards |
|---|---|
| `research-governance-postgres` | small-cell suppression, grant scoping, export gating, artifact permission re-checks |
| `case-lock-postgres` | compare-and-set on the case lock |
| `case-patch-postgres` | PATCH transaction integrity |
| `clinical-serialization-postgres` | serialization of concurrent clinical writes |

`npm test` skips all four, so a normal run reports "4 skipped". They **do** run in
CI, where `release-gate.yml` starts a `postgres:16-alpine` service on localhost
and sets the flag. That means the concurrency and confidentiality tier is green in
CI and invisible on a developer machine — easy to forget it exists.

## Running them locally

```bash
npm run test:pg              # all four
npm run test:pg:governance   # just the governance file
```

They read `DATABASE_URL` from `.env` and create their own fixtures, every id
suffixed with a `randomUUID()`, torn down in `afterAll`. So they are safe to point
at the shared **dev** database — they cannot collide with another run or with
seeded data.

## Two things that will bite you

**Your clock must be synced.** These tests compare locally generated timestamps
against ones the database generates. On 9 Aug 2026 this machine was **37 seconds
fast** (`w32tm /query /status` reported `Source: Local CMOS Clock`, `Last
Successful Sync Time: unspecified`), which failed
`clinical-serialization-postgres` with `expected <local ms> to be greater than or
equal to <db ms>` — a product-looking assertion failure caused entirely by the
machine. Check before believing a failure:

```powershell
w32tm /query /status          # want a real Source, not "Local CMOS Clock"
# to fix, in an ELEVATED shell:
w32tm /config /syncfromflags:manual /manualpeerlist:"time.windows.com,0x9" /update
Start-Service w32time
w32tm /resync /force
```

**Latency matters.** The timing-sensitive files (`case-lock`,
`clinical-serialization`) assume a local database — CI gives them sub-millisecond
round trips. Against remote Supabase (~60 ms round trip) their 5-second timeouts
and lock-expiry windows are tight enough to fail spuriously.

`research-governance-postgres` and `case-patch-postgres` have no such assumption
and pass cleanly against the dev database.

**So:** run `test:pg:governance` against dev whenever you touch research access,
disclosure or exports. For the other two, trust CI, or stand up a local Postgres
(`postgres:16-alpine` on 5432, matching the gate) and point `DATABASE_URL` at it.
