# LOSPOR API

The LOSPOR V7 database and HTTP service. This repository is the only owner of
PostgreSQL access, Prisma migrations, authentication, email, AI adapters, PDF
generation, audit persistence, OMOP export, and backend maintenance jobs.

## Local development

```bash
npm ci
cp .env.example .env.local
npx prisma migrate deploy
npm run dev
```

The API listens on `http://localhost:3002`. Liveness is available at
`/health/live`, database readiness at `/health/ready`, and the versioned API
under `/v1`.

The V7 local extraction uses the existing development database. Do not point
this repository at the production database. `DATABASE_URL` may use the normal
application pool; `DIRECT_URL` must be a direct/session PostgreSQL connection
that supports transactions and row locks used by clinical finalization.

## Pediatric development

Pediatric mode is enabled automatically outside production. Apply all pending
pediatric migrations only to the intended disposable/local development
database before testing. Do not apply them to production as part of local
verification.

Pediatric writes require an `X-LOSPOR-Client-Version` compatible with V8.
Production uses a double gate: `PEDIATRIC_MODE_ENABLED=true` and a Core
clinical manifest with `PEDIATRIC_PRODUCTION_READY=true`. The current draft
manifest remains false.

`GET /v1/clinical/pediatric/rules` returns the institution's assigned published
preset plus approved local changes. Platform administrators manage versioned
presets and assignment through `GET/POST /v1/clinical/rules/workbench`; the
older `/v1/admin/clinical-rules` path is a temporary compatibility wrapper.
Every institution has one preset. A HOD initiates a local change with a
rationale and designated reviewer; references are not required. Proposal,
designated review, and final HOD/admin approval must be performed by three
different people. Pending and rejected changes never appear in the effective
runtime response.
The generated OpenAPI document is available at `/openapi.json`. V7 initially
accepts first-party LOSPOR clients only; third-party credentials and scopes are
not enabled.

Research exports require finalized-only cohorts. Configure either private
filesystem storage for local/self-hosted development or S3-compatible object
storage for serverless deployments. `RESEARCH_EXPORT_RETENTION_DAYS` defaults
to 30. Run `npm run research-exports:work` on a schedule: it generates queued
exports, removes abandoned working files, and deletes expired artifacts while
retaining checksums and export history.

## Verification

```bash
npm run verify:boundaries
npm run openapi:generate
npm run test
npx tsc --noEmit --pretty false
npm run lint
npm run build
```

## Deployment

Deploy this repository before web. The intended public origin is
`https://api.lospor.org`. The API Vercel project owns `DATABASE_URL`,
`DIRECT_URL`, signing/email/AI secrets, `prisma migrate deploy`, and the
retention cron. The web project must not receive those values.

`output: standalone` is enabled so the same service can later run as a local
Node/container process at an institution.
