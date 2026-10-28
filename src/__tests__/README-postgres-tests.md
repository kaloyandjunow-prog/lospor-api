# The `*-postgres.test.ts` files

Twenty-three test files are gated behind `LOSPOR_POSTGRES_INTEGRATION=true`. Two of them
need a second flag as well, so `npm run test:pg` alone does **not** run
everything — see the table.

| File | Extra flag | What it guards |
|---|---|---|
| `research-governance-postgres` | — | small-cell suppression, grant scoping, export gating, artifact permission re-checks |
| `case-lock-postgres` | — | compare-and-set on the case lock |
| `case-patch-postgres` | — | PATCH transaction integrity |
| `clinical-serialization-postgres` | — | serialization of concurrent clinical writes |
| `audit-atomicity-postgres` | — | audit entries commit in the same transaction as what they describe |
| `conflict-override-postgres` | — | overriding a save conflict |
| `finalization-append-only-postgres` | — | finalization rows append and supersede rather than rewrite |
| `seed-icd10-bundle-postgres` | — | the ICD-10 bundle seed |
| `bundled-baseline-provisioner-postgres` | `LOSPOR_BUNDLED_BASELINE_POSTGRES=true` | the bundled clinical baseline provisioning transaction |
| `deployment-username-identity-postgres` | `LOSPOR_USERNAME_IDENTITY_POSTGRES=true` | Hospital username uniqueness/case-insensitivity constraints |
| `case-bounds-postgres` | — | moving a case start or end refused while charted entries would fall outside it |
| `case-cancel-postgres` | — | a cancelled procedure: reason and note, write access, too late after anaesthesia starts, closed to edits, undo, audit |
| `case-event-made-at-postgres` | — | of two changes to one event, the last one made wins |
| `case-event-routes-postgres` | — | the event edit and delete routes |
| `dashboard-case-counts-postgres` | — | the dashboard counts and scopes |
| `intraop-timeline-postgres` | — | the intraop timeline projection |
| `operating-theatres-postgres` | — | operating theatres through their routes: off and on, assign, the changed-meanwhile refusal, retired theatres, a cancelled case, locked at intraop start |
| `preop-answers-postgres` | — | preop answer rows |
| `preop-documents-postgres` | — | the preop summary and consent settings |
| `preop-orders-postgres` | — | preop ward orders and medication instructions |
| `preop-profiles-postgres` | — | the adult and paediatric preop profiles |
| `preop-suggestion-routes-postgres` | — | the preop suggestion routes |
| `unit-indicators-postgres` | — | the unit indicators: filters and their choices, grouping by procedure done, cancellations, colleague names, the per-case cache |

**Keep this table in step with the directory.** It drifted to four entries while
six more files were added, which is how a whole tier of coverage becomes easy to
forget. `ls src/__tests__/*-postgres.test.ts` is the authoritative list; the
extra flags are visible as the `runPostgres` condition at the top of each file
and in the `test:pg:*` scripts in `package.json`.

A plain `npm test` skips every one of them, so a normal run reports them as
skipped rather than passing. They **do** run in CI: both `ci.yml` and
`release-gate.yml` start a `postgres:16-alpine` service on localhost and set
`LOSPOR_POSTGRES_INTEGRATION=true`. That means the concurrency and
confidentiality tier is green in CI and invisible on a developer machine.

## Running them locally

```bash
npm run test:pg                    # every file whose only gate is the main flag
npm run test:pg:governance         # just the governance file
npm run test:pg:bundled-baselines  # sets LOSPOR_BUNDLED_BASELINE_POSTGRES too
npm run test:pg:username-identity  # sets LOSPOR_USERNAME_IDENTITY_POSTGRES too
```

They read `DATABASE_URL` from `.env` and create their own fixtures, every id
suffixed with a `randomUUID()`, torn down in `afterAll`. So they are safe to point
at the shared **dev** database — they cannot collide with another run or with
seeded data.

## Two things that will bite you

**Your clock must be synced.** These tests compare locally generated timestamps
against ones the database generates, so a host clock running ahead of the
database fails `clinical-serialization-postgres` with `expected <local ms> to be
greater than or equal to <db ms>` — an assertion failure that looks like a
product bug but is entirely the machine. Confirm the host is synced to a real
time source before believing that failure.

**Latency matters.** The timing-sensitive files (`case-lock`,
`clinical-serialization`) assume a local database — CI gives them sub-millisecond
round trips. Against a remote database (~60 ms round trip) their 5-second timeouts
and lock-expiry windows are tight enough to fail spuriously.

`research-governance-postgres` and `case-patch-postgres` have no such assumption
and pass cleanly against the dev database.

**So:** run `test:pg:governance` against dev whenever you touch research access,
disclosure or exports. For the timing-sensitive ones, trust CI, or stand up a
local Postgres (`postgres:16-alpine` on 5432, matching the gate) and point
`DATABASE_URL` at it.
