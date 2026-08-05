# Changelog - LOSPOR API

## [8.3.0] - 2026-08-05

Requires `@lospor/core` v8.3.0.

### Added

- **Changing institution is a request that somebody decides.**
  `POST /v1/user/institution-request` files one; `GET /v1/admin/institution-requests`
  is the queue; `POST /v1/admin/institution-requests/{id}` approves or rejects.
  The queue is scoped to the institution being *joined*, not the one being left —
  approving is what lets a head of department see the newcomer's cases, so it is
  the receiving department that decides. A head of a different institution gets
  404 rather than 403, so they learn nothing about requests that are not theirs.
- **Leaving applies at once.** A move to `no-institution` needs nobody's
  approval: it grants no one anything, and requiring the hospital's permission to
  stop working there would trap people in a department they have left. Recorded
  as a self-resolved request and audited as `INSTITUTION_CHANGE_SELF_LEAVE`.
- `scripts/bootstrap-admin.ts` (`npm run bootstrap:admin`) — sets role,
  approval and email verification together, and refuses if an administrator
  already exists.

### Fixed

- **A departmental drug-profile edit could not be saved at all.** The authoring
  scope guard compared canonical units with `!==` and route units as raw JSON
  text. Units are objects, so the first compared references and the second
  compared key *order* — which zod rewrites on every save. An untouched unit
  therefore always looked changed, and an institution or personal ruleset was
  refused with "canonical units are fixed by the platform ruleset" whether it
  was widening a dose or narrowing one. Both now compare by a key-sorted
  canonical form.
- **A partial Aldrete score was summed with the missing components counted as
  zero.** One component recorded as 2 was stored as a total of 2/10 — a patient
  documented as apnoeic and unresponsive. `mapPostop` now uses core's rule: no
  total until all five are assessed.
- **A fresh installation could not sign anyone in.** Sign-in required
  `approvedAt`, which only an administrator could set, and there was no
  administrator. Approval is no longer a sign-in gate; email verification is.
- **Finalisation checked that a preoperative record existed, and nothing more.**
  A draft with only an id could be finalised through the API while every client
  refused to. It now validates the record and returns every blocker in
  `blockers[]` rather than only the first.
- **A case no longer follows its author between hospitals.** The
  head-of-department scope carried an owner fallback, so moving a clinician
  handed their entire history to the new department's head. A head now matches
  on institution alone, in the query and in both in-memory access checks.

### Changed

- **Registration requires `institutionId`.** Every account belongs to an
  institution; "Без институция" (`no-institution`) is the answer when none of the
  listed hospitals fit. Breaking for any client that omits the field.
- Granting head of department is refused with 422 for an institution that cannot
  have one.

### Database

Three migrations, applied automatically by the production build:

- `20260805120000_institution_change_request` — the request table.
- `20260805140000_no_institution_backfill` — creates "Без институция" and moves
  users with no institution into it.
- `20260805160000_no_institution_case_backfill` — the same for cases, so the
  column stops carrying two ways of saying the same thing. Visibility is
  unchanged: that institution has no head of department, so those cases stay
  with their author and with administrators exactly as they did.

## [8.2.1] - 2026-08-05

Requires `@lospor/core` v8.2.1.

### Changed

- Repinned to `@lospor/core` v8.2.1. No API behaviour changes: the fix is in
  measurement display, which the API does not use.

## [8.2.0] - 2026-08-05

Security and access-control fixes, and the dose calculation is brought under the
authoring scope guard.

Requires `@lospor/core` v8.2.0.

**Includes 8.1.0, which was never deployed** — its pull request was not merged,
so production remained on 8.0.0 with `@lospor/core` v8.0.0. Pediatric mode
therefore becomes active with this release, given `PEDIATRIC_MODE_ENABLED=true`.

### Fixed

- CORS and CSRF no longer fail open. `allowedCorsOrigin` returns `null` rather
  than falling back to the first configured origin, and the header is omitted
  entirely when no origin matches. With no trusted origins configured, CSRF
  checking now fails closed in production instead of being skipped. Preview
  deployments are correctly treated as non-production: they set
  `NODE_ENV=production`, which the old check read as live.
- Research and OMOP CSV exports neutralise formula cells. A value beginning
  `=`, `+`, `-`, `@`, tab or carriage return is prefixed with an apostrophe, so
  a spreadsheet renders it as text instead of executing it.
- AI request logs no longer carry clinical free text.
- A case is scoped to the institution it was performed at, not to wherever its
  author currently works. A head of department moving hospitals previously took
  visibility of their old cases with them.
- An unapproved account cannot sign in. Approval was checked nowhere, so it
  governed only whether someone appeared in colleague lists; and verifying an
  email address also set `approvedAt`, meaning clicking the link in your own
  inbox approved your own account. Institution is no longer self-editable
  through the self-service patch endpoint.
- The authoring scope guard now covers the dose calculation. It protected drug
  identity, display names, units, routes, slider bounds and concentrations, but
  not the arithmetic that turns a weight into milligrams: an institution or a
  member could multiply a per-kilogram dose tenfold, switch ideal to total body
  weight, delete a dose ceiling, invent quick doses, stretch an age band to
  birth or eighteen years, or give an automatic dose to a drug the platform
  ruleset withheld. All follow the rule the sliders already did — narrow, never
  widen. A department may still prescribe less, cap harder, remove quick doses,
  narrow a band and withdraw a drug; and a withheld drug may still be shown for
  manual entry, because a register has to record a drug that was given.

### Changed

- `PEDIATRIC_DRUG_DOSE` is rejected for authoring; see core v8.2.0. Stored rules
  of that kind still read, and none exist.
- Destructive maintenance scripts require `LOSPOR_ALLOW_PROTECTED_DB` to name
  the target Supabase project before they will touch a protected database.

## [8.1.0] - 2026-08-04

Pediatric dosing cleared for production.

Requires `@lospor/core` v8.1.0, in which `PEDIATRIC_PRODUCTION_READY` is `true`.

### Changed

- Pediatric case mutations are no longer rejected with
  `503 PEDIATRIC_MODE_DISABLED` once `PEDIATRIC_MODE_ENABLED=true` is set in the
  production environment. Both are required: the reviewed clinical manifest in
  core, and the deployment flag. Setting either alone leaves pediatric mode off.
- `clinicalRulesVersion` stamped on pediatric doses is now
  `2026.08.04-release.1`, from core — previously it read `…-draft.1`.

### Tests

- The pediatric gate test now passes `productionReady` explicitly for each case,
  so it pins the gate's logic rather than the current value of the shipped
  constant, and does not need rewriting whenever the clinical sign-off changes.
  A separate case records the current sign-off, so reversing it is deliberate
  and visible.

## [8.0.0] - 2026-08-04

First stable release. Adds pediatric clinical mode, the clinical-ruleset API,
and dose provenance.

Requires `@lospor/core` v8.0.0.

### Added

- Pediatric clinical mode on `Case`, with research-grade age capture.
- `ClinicalPreset` and `ClinicalPresetRule`, plus the selection tables backing
  the PLATFORM / INSTITUTION / USER ruleset hierarchy.
- Authoring scope guard. Below PLATFORM a ruleset may adjust presentation --
  ranges, quick values, display names -- but not schema: no new drugs, units,
  routes or concentrations, and a slider may narrow but never widen. Keeping
  authored rules inside the canonical vocabulary is what keeps the recorded data
  research-capable.
- `CaseEvent` records which rule and preset produced a dose and on what weight
  basis, so an administration stays reproducible after the ruleset moves on.
- Guarded scripts to create, publish, verify and prune platform rulesets, each
  refusing to run against a production-like database.

### Fixed

- Removed the `lospor-standard-v1` placeholder preset that the ruleset
  migrations seeded. It was created `PUBLISHED` with no rules to satisfy the
  NOT NULL foreign keys being added, then selected for every institution. Since
  preset resolution takes the first `PUBLISHED` preset from
  `[user, institution, platform]` and does not check whether it has rules, that
  left every institution resolving pediatric dosing to an empty ruleset — and a
  real ruleset published at platform scope could not have overridden it, because
  institution selections win. Found by restoring the production backup and
  running the migrations against it.

### Migrations

Ten migrations, all additive relative to v7.3.2: every `DROP COLUMN` in this
batch removes a column added earlier in the same batch, and no new `NOT NULL`
column lacks a default. A rollback to v7.3.2 therefore needs no schema
downgrade -- though cases recorded in pediatric mode will not be understood by
a v7.3.2 client.

## [7.3.2] - 2026-07-28

### Fixed

- Web timetable reconciliation and projection now use the same locked database
  transaction as the section save, preventing self-deadlock and outliving writes.
- Added a real-PostgreSQL route regression that verifies section data, event
  rows, projection, and revisions commit together within a bounded time.
## [7.3.1] - 2026-07-28

### Fixed

- API health, capabilities, research metadata, personal archives, research
  export records, and OpenAPI now derive the release version from one canonical
  package value.
- Added regression coverage that prevents public and persisted API metadata
  from drifting behind future releases.
## [7.3.0] - 2026-07-28

### Fixed

- Database row locks now serialize case finalization with all section and event
  writes, preventing completed cases from diverging from their snapshots.
- Research export manifests track parent, event, relational, and section
  revisions so child-row changes cannot pass snapshot validation.

### Changed

- Research exports accept finalized-only cohorts, map each OMOP page once, and
  remove private working files after artifact generation.
- Generated artifacts expire after the configured retention period while their
  immutable checksum, row count, source version, and audit history remain.
- Prisma runtime, PostgreSQL adapter, and generator are pinned to 7.9.1.

## [7.2.1] - 2026-07-27

### Security

- Updated Next.js and its PostCSS/Sharp runtime chain to patched versions.
- Refreshed transitive dependencies so the API reports zero npm audit findings.
- Moved CI and the cross-repository release gate to Node.js 24 actions.

## [7.2.0] - 2026-07-27

### Fixed

- Research permissions retain action-specific institution scopes, preventing
  inspection or export rights from escaping through a broader query grant.
- Aggregate-only requests never query or return pseudonymous case rows.
- Query, comparison, benchmark, distribution, and quality responses apply one
  small-cell policy using valid denominators and complementary binary counts.

### Added

- Immutable background research exports with transactionally captured and
  hashed case revisions, visible source-drift failure, checksummed artifacts,
  filesystem and S3-compatible storage adapters, lease recovery, failure-
  isolated bounded workers, and separate-table OMOP CSV ZIP files.
- Typed research OpenAPI request/response contracts and real PostgreSQL tests
  for lock concurrency, mixed institutional grants, revocation, and immutable
  artifact downloads.

### Changed

- Reusable OMOP selection/redaction logic now lives in the API service layer.

## [7.1.0] - 2026-07-27

### Added

- Governed `/v1/research/*` endpoints for cohorts, comparison, quality,
  benchmarks, pseudonymous case review, exports, saved cohorts, and access
  grants, with complete OpenAPI coverage and audit logging.
- Additive persistence for research grants, saved cohort definitions, and
  export history.

### Changed

- Research and clinical DTOs carry stable codes with canonical bilingual
  display metadata from Core.
- CSRF and CORS policy supports the explicitly configured standalone Database
  origin without weakening production origin checks.
- The cross-repository release gate now verifies the standalone Browser.

## [7.0.1] - 2026-07-25

- Case editing leases now use one atomic PostgreSQL compare-and-set operation,
  so simultaneous devices cannot both be told they own the same lock.
- OMOP exports refuse batches above 5000 cases with an explicit incomplete
  response instead of silently truncating valid-looking research data.
- Personal account exports are complete streamed ZIP archives with manifests,
  cursor-paged cases, audit history, role requests, and transfer history.
- OpenAPI now explicitly contracts every supported route, admin operation,
  health endpoint, and internal job; route/contract drift fails generation.
- Email-verification links now return users to the configured web application
  after the dedicated API verifies the token, instead of redirecting to a
  nonexistent page on the API host.
- Vercel preview builds no longer require production database credentials or
  run database migrations; production deployments still run `migrate deploy`.
- CI now runs migrations and lock concurrency tests against PostgreSQL, with a
  selectable cross-repository release gate for Core, API, web, PWA/mobile, and
  docs.

## [7.0.0] - 2026-07-25

### Added

- First release of the dedicated LOSPOR database and HTTP service.
- Versioned `/v1` routes for cases, authentication, account management,
  clinical libraries, search, AI, PDF generation, audit, OMOP, and
  administration.
- Process and database health checks, capability discovery, request IDs,
  generated OpenAPI, CORS/CSRF handling, and first-party bearer/cookie
  authentication.
- Standalone Node output for future institution-hosted deployment.

### Changed

- Prisma, PostgreSQL access, migrations, email, AI providers, audit
  persistence, OMOP export, and maintenance jobs move out of the web
  repository and into this service.
- English procedure search remains available when the interface language is
  Bulgarian; Bulgarian ICD-10 search continues to use its localized catalog.

### Release

- Deploy this service before web and PWA.
- The intended production origin is `https://api.lospor.org`.
- No new V7 database migration is required. The deployment still runs
  `prisma migrate deploy` to verify tracked migration state.
