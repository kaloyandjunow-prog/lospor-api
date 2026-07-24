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
this repository at the production database.

The generated OpenAPI document is available at `/openapi.json`. V7 initially
accepts first-party LOSPOR clients only; third-party credentials and scopes are
not enabled.

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
