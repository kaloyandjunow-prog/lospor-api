# Changelog - LOSPOR API

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
