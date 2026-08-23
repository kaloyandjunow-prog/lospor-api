# LOSPOR API

The LOSPOR V7 database and HTTP service. This repository is the only owner of
PostgreSQL access, Prisma migrations, authentication, email, AI adapters, PDF
generation, audit persistence, OMOP export, and backend maintenance jobs.

## Local development

```bash
npm ci
cp .env.example .env.local
npx prisma migrate deploy
npm run db:seed
npm run dev
```

The API listens on `http://localhost:3002`. Liveness is available at
`/health/live`, database/legal readiness at `/health/ready`, and the versioned
API under `/v1`.

### Bundled clinical baselines on a clean database

After migrations, `npm run db:seed` installs, publishes, and platform-selects
the exact source-controlled adult-v2 (251 rules) and pediatric-v2 (335 rules)
bundles. Both are always present regardless of later appliance exposure policy.
They are attributed to the immutable, non-login `LOSPOR 1.2.0` technical
principal, never to the Hospital administrator who chooses that policy.

The provisioner runs in one serializable transaction and re-reads every
identity, rule key, payload, source reference, version, publication digest,
selection, and bounded audit row before commit. An exact retry is a no-op. A
partial install, identity collision, content drift, login-account collision, or
different governed platform selection fails without repairing or overwriting
anything, and the seed exits nonzero. The standalone equivalent is deliberately
write-guarded:

```bash
npm run clinical-rules:provision-bundled-baselines -- --apply
```

This step creates no account, password, session, exposure toggle, or public-demo
account-administration capability. The opt-in real-PostgreSQL trigger and
rollback suite requires an empty disposable migrated database and both
`LOSPOR_POSTGRES_INTEGRATION=true` and
`LOSPOR_BUNDLED_BASELINE_POSTGRES=true`.

`User` and `TechnicalPrincipal` are separate database models, so Prisma cannot
express one cross-table unique constraint. The provisioner reserves
`lospor-release:1.2.0` by rejecting any pre-existing User, AuthSession, or even
unrelated AuditLog row using it; normal account creation always generates its
own ID. Operator scripts must never assign the reserved `lospor-release:`
namespace to a User.

`GET /v1/capabilities` is the authoritative client feature contract. External
AI has separate `clinicalAdvice`, `labImageExtraction`, and `monitorOcr`
capabilities with stable enabled/reason fields. With no provider key they are
unavailable; `LOSPOR_DISABLE_EXTERNAL_AI=true` or
`HOSPITAL_APPLIANCE=true` disables them even if a key is present. The matching
mutation routes enforce the same check before reading a clinical payload or
making provider egress, so clients must hide or explain a disabled control
rather than learning only after image capture/submission.

The same endpoint may publish one non-secret clinician support destination in
its top-level `support` object. Configure `LOSPOR_SUPPORT_URL` as HTTPS without
embedded credentials/fragments or a single bare `mailto:` mailbox. Mail query
content is discarded, invalid configuration fails closed, and clients remain
responsible for previewing any privacy-safe diagnostic text before a deliberate
export. The API never receives or sends that diagnostic report on behalf of a
client.

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
clinical manifest with `PEDIATRIC_PRODUCTION_READY=true`. The reviewed current
manifest is production-ready; deployment exposure remains a separate gate.

`GET /v1/clinical/pediatric/rules` returns the institution's assigned published
preset plus approved local changes. Platform administrators manage versioned
presets and assignment through `GET/POST /v1/clinical/rules/workbench`; the
older `/v1/admin/clinical-rules` path is a temporary compatibility wrapper.
Every institution has at most one selected preset for each clinical mode. A
HOD may publish and select a validated institution version after re-entering
their own password and recording a reason of at least ten characters; no
second reviewer is required. Publication stores immutable canonical before and
after JSON, exact added/removed/changed fields, and SHA-256 hashes in the same
transaction as the publication audit. Published rule rows cannot be edited.
Personal rulesets remain owner-only and may narrow, but not widen, the platform
baseline. Pending drafts never appear in the effective runtime response.
The generated OpenAPI document is available at `/openapi.json`. V7 initially
accepts first-party LOSPOR clients only; third-party credentials and scopes are
not enabled.

## Identity, locale, and legal documents

`User.role` controls clinical authority; the orthogonal `User.accountKind`
selects the application boundary. `RESEARCH_ONLY` accounts may use auth,
account/language, legal, and research endpoints, but clinical routes return
`403` with `code: CLINICAL_APP_FORBIDDEN`. Public registration always creates a
`CLINICAL` `MEMBER`, requires an institution and both exact legal acceptances,
and becomes usable after email verification. There is no account-approval
queue.

### Deployment-selected login identity

The public and serverless deployments use email for login and retain the
existing self-registration, email-verification, and email-recovery flows. A
Hospital appliance uses usernames only when both
`LOSPOR_DEPLOYMENT_MODE=hospital` and
`LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED=true` are present. A partial or unknown
Hospital configuration fails closed instead of falling back to public email
authentication. `GET /v1/capabilities` reports this boundary as
`loginIdentifier`, `selfRegistration`, and `passwordRecovery`.

Hospital usernames contain 3–64 characters, begin with an ASCII Latin letter,
and then contain only ASCII Latin letters, digits, `.`, `_`, or `-` (the exact
pattern is `^[A-Za-z][A-Za-z0-9._-]{2,63}$`). The spelling and capitalization
entered by the administrator are stored unchanged. Login and appliance-global
uniqueness use a separate lowercase canonical key. Inputs are neither trimmed
nor Unicode-normalized, so spaces, `@`, `/`, `\\`, control characters,
compatibility characters, and non-Latin text are rejected rather than silently
rewritten. Display names are separate and may use Cyrillic.

A Hospital account may have one normalized, unique contact email, but that
address is never a login fallback. Hospital provisioning, activation-link
distribution, administrator recovery, and administrator-only username changes
remain owned by the Hospital Status/API overlay; the shared owner API supplies
the schema, login, bootstrap, and capability primitives without exposing those
operations on the online serverless demo. A username stays reserved throughout
the reversible deletion window and is released only when terminal
anonymization replaces the stored login identity.

### Account lifecycle and sessions

Account state is explicit and non-destructive. `suspendedAt` temporarily closes
access without starting an erasure clock. `deletedAt` starts a reversible
30-day deletion window, after which the retention job removes direct
identifiers and sets terminal `anonymizedAt`. `POST
/v1/admin/users/{id}/restore` is available only inside that window and clears
deletion into `RECOVERY_REQUIRED`; it never revives an old password or session.
A successful one-time password recovery clears that state.

Administrator lists return `INVITED`, `ACTIVE`, `SUSPENDED`,
`DELETION_PENDING`, or `RECOVERY_REQUIRED`, lifecycle timestamps, login and
password epochs, exact legal acceptances, and an exact legal-current result.
Use `?status=...`; `?pending=true` remains a one-release alias for `INVITED`.
Suspended, recovery-required, deleted, and anonymized accounts are excluded
from colleague, handover, research-grant, and pending membership surfaces.

`POST /v1/user/change-password` requires the current password, rejects reuse,
consumes outstanding reset links, revokes every session, writes its audit in
the same transaction, clears the browser cookie, and requires sign-in again.
Public reset requests always return the exact same `{ "ok": true }` body with
HTTP 202, independent of account existence or mail delivery. Reset and email
verification tokens are conditionally claimed, so only one concurrent request
can consume a link.

Every new Web, PWA, or Native JWT has an `AuthSession` row containing its random
JTI, client type, normalized device label, issue/last-seen/expiry timestamps, and
revocation state. `GET /v1/user/sessions` lists live sessions; deleting that
collection signs out every other device, and deleting a specific id revokes
that other session. Logout expires the HttpOnly cookie on success and failure,
but returns 503 when durable revocation cannot be confirmed so a client cannot
claim a false success. Browser session POST/DELETE requires a trusted Origin or
Referer even if a caller adds a Bearer header; native login remains
`POST /v1/auth/token`.

Administrator promotion/demotion uses the distinct
`POST /v1/admin/users/{id}/authority` operation and requires the acting
administrator's password plus a reason. The transition is serializable,
audited, revokes the target's sessions, and cannot leave zero active clinical
administrators. Clinical/research account-kind changes use this same step-up
operation; routine Member/HOD changes remain on `PATCH /v1/admin/users/{id}`
but also revoke the target's prior sessions before the new authority applies.
Routine suspension/reactivation/restore operations require a reason. These new
lifecycle/authority routes are not enabled on the online serverless demo: they
require both `LOSPOR_DEPLOYMENT_MODE=hospital` and
`LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED=true`, and the same state is reported as
`features.accountAdministration`. Clients must fail closed unless that exact
capability is enabled.

### Durable audit evidence

Privilege, account, legal, role, institution, research-access, and API-owned
clinical-ruleset lifecycle changes write their evidence through the same
Prisma transaction as the governed mutation. If that evidence cannot be
inserted, the mutation does not commit. Routine high-volume case-event and view
telemetry remains deliberately best-effort and must not be used as proof that a
governance transition completed.

[`AUDIT_GOVERNANCE.md`](AUDIT_GOVERNANCE.md) documents the executable HAUD-01
inventory gate, its rollback-injection coverage, the retained PostgreSQL
atomicity proof, Hospital-owned boundaries, and the six actor-principal-blocked
operator scripts. A new governed-model mutation that is neither inventoried nor
narrowly and explicitly excluded fails the gate.

`src/lib/audit-actions.ts` is the append-only action-code authority. `GET
/v1/admin/audit-logs` returns its Bulgarian and English labels with every page
and rejects unknown exact action filters. First-party clients consume this
catalog rather than maintaining an independent list. Existing action codes may
gain clearer labels but must never be renamed or reused.

Audit JSON contains stable opaque IDs, roles, transitions, changed field names,
counts, timestamps, publication hashes, and an operator-supplied governance
reason only where the product explicitly requires one. Reasons must describe
the decision without patient or unnecessary account identifiers. The shared
writer fails closed for credential/password/token fields, direct account PII,
patient numbers, case codes, and raw clinical payloads. Never bypass that writer
for an authenticated governance route.

When `LOSPOR_ADMIN_MFA_REQUIRED=true`, a clinical `ADMIN` receives no session
after password verification alone. The API returns a five-minute, one-use MFA
continuation; first use enrolls an RFC 6238 TOTP seed and returns exactly ten
high-entropy recovery codes once, while later use accepts either a fresh TOTP
step or one unused recovery code. Seeds are AES-256-GCM protected with the
separate 32-byte key supplied through `LOSPOR_MFA_ENCRYPTION_KEY_FILE` (or the
development-only environment value), challenge tokens and recovery codes are
hashed at rest, and a TOTP time step cannot be replayed through concurrent
challenges. Readiness fails if MFA is required without a usable key. The public
demo leaves this gate disabled; Hospital enables it and owns key escrow,
Status-operator MFA, and mail-independent recovery-link distribution.

The PWA identifies itself only while creating its same-origin cookie session.
The resulting signed token carries `clientType=PWA`; later clinical-event
writes derive their `web`/`mobile` provenance from that authenticated claim.
`X-LOSPOR-Source` and later client-identity headers cannot rewrite it. Tokens
issued before this contract age out within eight hours and retain only their
historical cookie-versus-bearer fallback during that window.

`GET /v1/capabilities` reports `authentication.selfRegistration` and the
non-sensitive password-recovery mode. Set `LOSPOR_SELF_REGISTRATION_ENABLED`
and `LOSPOR_PASSWORD_RECOVERY_MODE=EMAIL|ADMINISTRATOR|UNAVAILABLE` to describe
the deployment truthfully; absent an explicit recovery mode, a configured
Brevo key yields `EMAIL`, otherwise `UNAVAILABLE`.

Before login, `GET /v1/locale` returns validated `LOSPOR_DEFAULT_LOCALE` (`bg`
when missing or invalid), and `POST /v1/locale` stores an explicit browser
choice in a cookie. Neither changes an account. After login,
`User.preferences.ui.locale` is the only authority. Browser and native login
accept optional `locale: "bg" | "en"` only for an explicit selector choice and
persist it in the same login request; later changes use `PATCH /v1/user` with
`{ "preferences": { "ui": { "locale": "en" } } }`.

`LOSPOR_LEGAL_DOCUMENTS_JSON` is mandatory. It contains the exact UTF-8 text
served by `GET /v1/legal/documents?locale=bg|en`; the server computes and
returns its lowercase SHA-256. Each descriptor is
`{ kind, version, effectiveDate, locale, contentSha256, deployment }`.

For the public demo, generate the canonical manifest from the exact copy shown
by `lospor-app` and set its complete one-line output as the environment value:

```bash
npm --prefix ../lospor-app run legal:manifest
```

The generator uses deployment `CLOUD_DEMO`, version `4.0`, effective date
`2026-07-03`, and checksums computed from the displayed Bulgarian and English
document objects. API and Web must be released together if any byte changes.

Another deployment must configure exactly one Terms and one Privacy document
per supported locale using the same shape:

```json
{
  "deployment": "LOCAL_HOSPITAL",
  "documents": [
    { "deployment": "LOCAL_HOSPITAL", "kind": "TERMS", "version": "1.0", "effectiveDate": "2026-09-01", "locale": "bg", "content": "<exact approved Bulgarian Terms>" },
    { "deployment": "LOCAL_HOSPITAL", "kind": "PRIVACY", "version": "1.0", "effectiveDate": "2026-09-01", "locale": "bg", "content": "<exact approved Bulgarian Privacy notice>" },
    { "deployment": "LOCAL_HOSPITAL", "kind": "TERMS", "version": "1.0", "effectiveDate": "2026-09-01", "locale": "en", "content": "<exact approved English Terms>" },
    { "deployment": "LOCAL_HOSPITAL", "kind": "PRIVACY", "version": "1.0", "effectiveDate": "2026-09-01", "locale": "en", "content": "<exact approved English Privacy notice>" }
  ]
}
```

Do not use the placeholders above. A missing/duplicate translation, invalid
date, deployment mismatch, or configured hash that differs from the content
makes `/health/ready` return `503`. Registration and re-acceptance validate
both client references against this server-active manifest; arbitrary client
versions or hashes are never persisted.

## Immutable case creator

`Case.createdById` records who created the case and never changes;
`Case.userId` remains the current assignee and changes on accepted handover.
The creator may continue to read the case only while their current institution
matches the case's institution snapshot. The creator is read-only after
handover. Responses expose `capabilities.canRead`, `canWrite`, `isCreator`, and
`isAssignee`; clients must use those capabilities instead of inferring edit
rights from authorship.

Demoting a head of department does not reassign any case. Cases currently
assigned to that clinician remain editable by them; only live locks they held
on somebody else's case through department-wide authority are released in the
same transaction as the demotion and audit entry.

## Research governance

Research authorization is resolved from live, time-bounded grants. Query,
case-level inspection, CSV/JSON export, OMOP export, and cohort sharing are
independent permissions. Clinical administrators receive aggregate query only
by role; members and heads receive no implicit research access. A clinical
account may self-authorize aggregate-only query for eight hours, at most once
per rolling 24 hours. It never grants inspection or export.

Research responses and artifacts use stable `Case.researchId` values and never
publish operational case IDs, case codes, patient-link IDs, identifier hashes,
or hospital patient numbers. Counts from one through four are rendered as
`<5`, with complementary suppression applied before release. OMOP requires
both ordinary export and OMOP permissions.

Research exports require finalized-only cohorts. Configure either private
filesystem storage for local/self-hosted development or S3-compatible object
storage for serverless deployments. `RESEARCH_EXPORT_RETENTION_DAYS` defaults
to 30. Run `npm run research-exports:work` on a schedule: it generates queued
exports, removes abandoned working files, and deletes expired artifacts while
retaining checksums and export history.

Saved-cohort updates may include `expectedUpdatedAt`, copied from the cohort
being edited. The API compares it in the atomic update predicate and returns
HTTP 409 with `COHORT_CHANGED` if another update won first. Clients should then
reload and ask the owner to reconcile the definitions; they must not retry a
stale body unconditionally.

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
