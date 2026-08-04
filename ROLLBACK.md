# Rolling back from v8.0.0

Written 2026-08-04, before v8.0.0 was deployed. Read the whole file before
acting: the fastest correct move depends on whether pediatric cases have been
recorded yet.

## The short version

**Rolling back is a code-only redeploy. Do not roll the database back.**

v8's schema is purely additive relative to v7.3.2, so a v7.3.2 deployment runs
correctly against the v8 database. Downgrading the schema would destroy v8 data
for no benefit.

## Why no schema downgrade is needed

Checked against `git show <v7.3.2>:prisma/schema.prisma`:

- v7.3.2's schema contains none of `clinicalMode`, `clinicalPresetId`,
  `prematurityStatus`, `gestationalAgeWeeks`.
- Every `DROP COLUMN` in the nine v8 migrations removes a column **added earlier
  in the same batch** — `20260730010000_remove_pediatric_maturity_context` drops
  what `20260729100000` added; `20260731100000` drops the `clinicalPresetId`
  that `20260730140000` added.
- No v8 migration adds a `NOT NULL` column without a default, so v7.3.2's
  inserts still succeed against the v8 schema.

## The one thing that is not safe

Structural safety is not semantic safety.

Cases recorded with `clinicalMode = PEDIATRIC` are **not understood by v7.3.2**,
which has no concept of pediatric mode. Rolling back hides those cases rather
than corrupting them — the rows stay intact and reappear when you roll forward —
but a clinician on v7.3.2 will not see them.

Before rolling back, check how many exist:

```sql
SELECT count(*) FROM "Case" WHERE "clinicalMode" = 'PEDIATRIC';
```

Zero: roll back freely. Non-zero: you are trading those cases' visibility for
whatever the rollback fixes. Decide deliberately, and tell the department.

## Rollback targets

| Component | Roll back to |
|---|---|
| lospor-app | `dpl_Efu1tnvkpkm42zsto2DHz5KRnj35` — v7.3.0, deployed 2026-07-28T03:43:52Z, commit `779d8fa` on `main` |
| lospor-app (older) | `dpl_5VfzCg76QGNZeQwayc7qbi5DUHfQ` — v7.2.1, deployed 2026-07-27T21:20:14Z, commit `e12afba` |
| lospor-api | see "Unverified" below — get the deployment ID from the dashboard |
| lospor-mobile | Play Console: halt the v8 rollout; `versionCode 30` is the previous build |

Both app deployments above were reported by Vercel as
`isRollbackCandidate: true` at the time of writing.

## How to roll back the web app

Vercel dashboard → lospor-app → Deployments → the deployment above →
**Instant Rollback** (or Promote to Production). This re-points the alias at an
existing build; it does not rebuild, so it takes seconds.

Do **not** roll back by reverting commits and redeploying — that rebuilds, takes
minutes, and can pick up dependency drift.

## How to roll back the API — read this first

`lospor-api/vercel.json` runs the migration inside the production build:

```
"buildCommand": "if [ \"$VERCEL_ENV\" = \"production\" ]; then prisma migrate deploy; fi && npm run build"
```

Two consequences:

1. **Deploying api to production migrates the production database**, without a
   separate confirmation step. Take a Supabase backup or PITR restore point
   *before* the deploy, not before some later "migration step" — there isn't one.
2. Rolling back via **Instant Rollback** does not run a build, so it does not
   run migrations. That is the safe path, and it is another reason not to roll
   back by rebuilding an older commit: a rebuild of v7.3.2 would run
   `prisma migrate deploy` against the v8 schema. That is *currently* harmless,
   since migrations only ever move forward, but it is a needless risk during an
   incident.

## Mobile

Mobile cannot be rolled back for users who already updated; Play does not
un-install a version. What you can do:

- Halt the staged rollout in Play Console before it reaches everyone.
- Publish `versionCode 30` again only as a new, higher `versionCode` — Play
  refuses a decreasing one.

Staging the v8 rollout to a small percentage first is what makes this
recoverable at all.

## Unverified at the time of writing

- **The API's current production deployment ID was not captured.** The Vercel
  token available did not have permission to list deployments for the
  `lospor-api` project (`403 forbidden`; the project is not even visible to it,
  unlike lospor-app and lospor-mobile). Get the ID from the dashboard and record
  it here **before** deploying v8 — an incident is the wrong time to go looking.
- **This rollback has not been rehearsed.** An untested rollback is not a
  rollback. Rehearse it: promote the previous deployment, confirm v7.3.2 serves
  against the v8 schema, then promote v8 forward again.

## Health checks

```
curl https://api.lospor.org/health/ready     # {"status":"ready","database":"ok"}
curl -o /dev/null -w "%{http_code}" https://lospor.org
```

A `307` from an app route is the auth redirect firing before the page compiles.
It is not a health signal — it has been misread as one before. Check a real
authenticated page load instead.
