# LOSPOR API

- This repository is the sole owner of database access, Prisma migrations,
  authentication, email, AI adapters, PDF generation, audit persistence,
  OMOP persistence/export, and HTTP route behavior.
- Canonical routes use `/v1`. Do not add a second implementation under
  `/api`; the web repository owns only the temporary compatibility proxy.
- Keep reusable pure clinical and synchronization decisions in
  `@lospor/core`. Keep React, Expo, browser storage, and device APIs out of
  this repository.
- Run `npm run openapi:generate` when routes change. OpenAPI coverage tests
  must include every non-internal V1 operation.
- Before completing API changes, run `npm run verify:boundaries`,
  `npx prisma validate`, `npx tsc --noEmit --pretty false`, `npm run lint`,
  `npm test`, and `npm run build`.
- Never run migrations, seeds, production deployment, push, or tags without
  explicit authorization.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
