# Changelog - LOSPOR API

## [Unreleased]

### Changed

- Durable governance evidence now commits in the same database transaction as
  account provisioning/activation, activation and recovery-link issuance,
  legal acceptance, role and institution decisions, account lifecycle and
  authority changes, research grants, and every API-owned clinical-ruleset
  lifecycle mutation. Audit failure therefore rolls the governed mutation
  back instead of leaving an unrecorded privilege or policy change.
- Audit detail is privacy-minimized and rejected when it contains credential,
  token, direct account-PII, patient-number, case-code, or raw clinical-payload
  fields. Retention anonymization is retryable per account when its durable
  evidence cannot be written.
- Bound intraoperative event provenance to the authenticated session instead of
  a caller-controlled header. Tracked sessions now distinguish `WEB`, `PWA`,
  and `NATIVE`; PWA and native writes are recorded as `mobile`, Web writes as
  `web`, and legacy sessions retain their transport-based classification only
  for their remaining eight-hour lifetime. Event add/edit/delete audit entries
  carry the same server-derived source, and the public OpenAPI contract no
  longer advertises `X-LOSPOR-Source` as writable input.
- Isolated the monitor-OCR case-authorization regression from its independent
  deployment-capability preflight. The full suite now proves both boundaries
  without relying on ambient provider configuration or leaking environment
  state between tests.
- Saved-cohort PATCH now supports optimistic concurrency through
  `expectedUpdatedAt` and returns `COHORT_CHANGED` on a stale revision. The
  patch schema no longer inherits the create schema's `PRIVATE` default, which
  previously risked changing shared visibility during an unrelated metadata
  edit.
- Kept the new administrator suspend/reactivate/restore/authority control plane
  off on the online serverless demo. Its API routes and capability now require
  both an explicit Hospital deployment and an explicit account-administration
  enable switch; clients fail closed unless the API returns `ENABLED`.
- Made the shared `AccountKind` migration safe when the Hospital 1.2
  provisioning overlay has already created the identical enum and user column.
  The shared API remains the schema owner; this only permits the documented
  deliberate upstream-to-appliance migration ordering without a duplicate-type
  failure.

### Added

- Deployment-selected login identity primitives for Hospital appliances:
  additive case-preserving `username`, lowercase appliance-global
  `usernameCanonical`, and deployment-neutral `activatedAt` fields; strict
  username-only Hospital login; unchanged public email registration,
  verification, and recovery; optional contact email with no login fallback;
  and first-administrator bootstrap support. Static and opt-in PostgreSQL tests
  cover the migration and case-insensitive uniqueness race. Hospital account
  provisioning, activation/recovery distribution, and administrator-only
  rename remain owned by the Hospital Status/API overlay and are unavailable
  on the public serverless demo.
- Clean-database provisioning for the exact canonical adult-v2 and
  pediatric-v2 baselines. LOSPOR 1.2.0 is their immutable non-login technical
  author/publisher/confirmer/selector; one serializable transaction writes and
  re-verifies publication evidence, governed selections, and bounded typed
  audit evidence. Exact retries are no-ops, while partial state, collisions,
  drift, and a different governed selection fail closed. Normal and E2E seeds
  use the same provisioner, with an explicit guarded CLI and opt-in real-
  PostgreSQL trigger/rollback coverage.
- An executable HAUD-01 governance inventory and source-discovery release gate
  now enumerate every owner privilege/lifecycle transition and bind it to its
  registered transactional action and rollback evidence. Audit-failure
  injection covers all unit-testable owner paths; the retained opt-in
  PostgreSQL suite remains the authoritative physical rollback proof. Hospital
  ownership, narrow authentication/fixture exclusions, source-only script
  limits, and the six unresolved actor-principal scripts are documented
  explicitly in `AUDIT_GOVERNANCE.md`.
- An append-only typed audit action registry with exact Bulgarian and English
  labels. `GET /v1/admin/audit-logs` returns the registry beside the page and
  accepts only an exact registered action filter, so owner clients cannot drift
  into incomplete hard-coded action menus.
- A fail-closed, non-secret support destination in `GET /v1/capabilities`.
  Deployments may advertise HTTPS help/ticketing or one bare `mailto:` mailbox;
  embedded credentials, fragments, malformed mailboxes, unsafe schemes, and
  oversized values are rejected, while preconfigured mail query content is
  stripped so clients control the reviewed diagnostic body.
- Deployment-gated clinical-administrator TOTP with a five-minute one-use
  password continuation, mandatory first-login enrollment, encrypted seeds,
  replay-safe time steps, and exactly ten hashed one-use recovery codes. The
  public demo remains unchanged unless it explicitly enables the complete MFA
  contract; readiness fails closed when a required encryption key is absent.
- Explicit account lifecycle states with separate suspension, reversible
  30-day deletion, terminal anonymization, and restoration into mandatory
  password recovery. Administrator lists expose typed state filters and the
  timestamps needed to distinguish invited, active, suspended, deletion-pending,
  and recovery-required accounts.
- Authenticated password change with current-password verification, reuse
  rejection, atomic audit, reset-token consumption, all-session revocation,
  and mandatory reauthentication.
- Server-side `AuthSession` inventory for Web and Native JWTs, including device
  label, issue/last-seen/expiry, selective revocation, and sign-out of every
  other session.
- Safe administrator succession through a distinct password-and-reason
  authority operation. Serializable last-admin checks prevent concurrent
  demotions, suspensions, deletions, or self-deletion from leaving no active
  clinical administrator. Clinical/research account-kind transitions use the
  same step-up operation, while every direct or approved Member/HOD and
  institution authority change revokes the target's prior sessions.
- Self-service first name, last name, and title correction with normalized
  display-name reconstruction and atomic changed-field audit.
- Non-sensitive authentication capabilities for self-registration, recovery
  mode, password change, and session inventory.

- Orthogonal `AccountKind` (`CLINICAL` or `RESEARCH_ONLY`) is resolved live for
  every authenticated request. Research-only accounts receive stable
  `CLINICAL_APP_FORBIDDEN` responses outside auth, account/language, legal, and
  research surfaces.
- Bulgarian-default account locale at `User.preferences.ui.locale`, exposed in
  sessions and account DTOs. Browser and native login can atomically persist an
  explicit pre-auth selector choice; ordinary preference updates remain
  available through `PATCH /v1/user`.
- Public `GET /v1/locale` exposes validated `LOSPOR_DEFAULT_LOCALE` without
  changing an account, for native clients before authentication.
- Deployment-aware, append-only Terms and Privacy evidence plus public
  `GET /v1/legal/documents?locale=bg|en`. Exact active descriptors and content
  are server-owned; incomplete bilingual configuration fails readiness.
- Immutable `Case.createdById`, separate from mutable assignee `userId`, with
  explicit read/write predicates and per-case capabilities. A same-institution
  creator retains read-only access after handover.
- Stable random `Case.researchId` pseudonyms, granular live research grants,
  and aggregate-only self-authorization lasting eight hours at most once per
  rolling 24 hours. Research APIs and OMOP mapping no longer expose operational
  case IDs or case codes.
- Immutable clinical-ruleset publication evidence with canonical before/after
  payloads, exact field-level diffs, hashes, confirmer, reason, and timestamp.
  Database triggers prevent published rules from being edited or selected
  without evidence.
- Machine-readable `clinicalAdvice`, `labImageExtraction`, and `monitorOcr`
  capabilities, each with an enabled state and stable reason. All three fail
  closed before payload processing or provider egress when the provider is not
  configured or deployment policy disables external AI; an accidentally
  supplied provider key cannot override the deployment switch.

### Changed

- Password-reset requests now always return the same HTTP 202 body for known,
  unknown, suspended, deleted, delivery-success, and delivery-failure paths.
  Reset and verification links are conditionally claimed; one concurrent
  request succeeds and all competing unused links are consumed.
- Browser session creation/deletion now requires a trusted Origin or Referer.
  A Bearer header cannot bypass this check on the cookie-setting route; native
  bearer login remains origin-independent at `/v1/auth/token`.
- Logout always expires the HttpOnly cookie but returns non-2xx when neither
  the tracked session nor legacy JTI blocklist can confirm durable revocation.
- Suspended, recovery-required, deleted, and anonymized accounts are excluded
  from colleague, handover, grant, and pending membership selection surfaces.

- Public registration requires an institution and exact Terms plus Privacy
  acceptance. Email verification activates an ordinary `MEMBER`; the generic
  administrator approval queue and endpoint are removed (old endpoints return
  explicit compatibility responses).
- Institution changes and HOD promotions now serialize on the user row. Moving
  a HOD to another institution demotes them to `MEMBER` in the same transaction
  so department-wide authority cannot move between hospitals.
- An institution HOD may widen or narrow an existing platform clinical rule,
  but cannot redefine canonical identity, units, or routes. Publication and
  selection require password re-entry plus a reason and commit their audit
  evidence atomically; no second reviewer is required. Personal rules remain
  owner-only and narrow-only.
- HOD demotion leaves every assigned case with the clinician and releases only
  locks on other clinicians' cases that depended on former department-wide
  authority. The last active clinical administrator cannot be demoted or
  converted to a research-only account.

### Migration and compatibility

- `20260823100000_pwa_session_provenance` adds `PWA` to the tracked-session
  client enum. Existing `WEB` and `NATIVE` rows are unchanged; newly created PWA
  cookie sessions carry the signed `PWA` claim used by clinical-event audit.
- `20260822150000_account_lifecycle_sessions` adds lifecycle timestamps and
  the `AuthSession` ledger. Legacy JWTs lack the new tracked-session claim and
  age out under their original eight-hour TTL; every newly issued JWT is
  selectively revocable. Legacy anonymized sentinel accounts are backfilled
  with terminal `anonymizedAt` and cannot be restored.

- Existing `RESEARCHER` roles backfill to `accountKind=RESEARCH_ONLY`; all
  others backfill to `CLINICAL`.
- Existing preferences preserve unrelated keys; missing/invalid
  `preferences.ui.locale` becomes `bg` and only case-insensitive `en` becomes
  `en`.
- No exact legal acceptance is invented from legacy timestamps. Existing users
  have no authoritative rows until they accept both active documents.
- `Case.createdById` backfills to the sender of the earliest accepted transfer,
  or the current assignee when no accepted-transfer evidence exists. If
  historical transfers allowed one creator to reuse a client draft id, both
  clinical records are retained: the earliest keeps the technical idempotency
  key and later collisions have only that key cleared before creator-scoped
  uniqueness is installed.
- Existing cases receive random, unique research pseudonyms. Existing published
  clinical presets receive deterministic legacy publication evidence before
  the database begins requiring evidence for every new publication.
- This is a coordinated, non-rolling database/API cutover: the migration drops
  the old `approvedAt` column and old API binaries must not run against the new
  schema. Take a restorable database snapshot and deploy Core/API before the
  clients that consume the new required contracts.

## [9.3.0] - 2026-08-20

### Fixed

- **A handover could make a clinician reuse a case number.** Case codes were
  derived from the highest code a clinician currently owned, and a handover
  changes what they own — so handing away your highest case lowered the ceiling
  and the next case you created took the number you had just handed over.
  Reproduced end to end: a clinician holding 2026-0001 to 0003 who hands 0003 to
  a colleague was issued 2026-0003 again. Nothing rejected it, because the
  unique constraint is `(userId, caseCode)` and the handed-over case now belongs
  to somebody else, so two different operations carried the same number on
  paper.

  Numbers now come from `CaseCodeSequence`, a counter per clinician per year
  that only ever moves forward, backfilled from what each clinician has already
  been issued. Gaps were always possible and still are — a deleted draft leaves
  one — but the code is the only link between a printed chart and its record, so
  it must never be handed out twice. A case arriving by handover also pushes the
  recipient's counter past it, since it usually keeps its number and would
  otherwise be issued again a few cases later.

- **A renumbered case could be moved into the wrong year.** Renumbering used the
  current year rather than the case's, so a pre-assessment done in December and
  accepted in January was renumbered into the recipient's *next* year — a year
  printed on the chart, and the one anyone totalling a year's work would count
  it under. Renumbering now stays inside the year the case already belongs to.

- **Three defects in the accept/decline path**, which had never run: accepting a
  case finalised while the handover sat pending was allowed, reassigning it
  underneath its own attestation; a cross-institution recipient surfaced as a
  bare 500; and nothing prevented two pending handovers on one case beyond the
  route remembering to check. All three now covered, the last by a partial
  unique index.

- **A member could not see anyone to hand a case to.** `colleagueWhereForUser`
  returned `null` for a member, and restricted a head of department to members —
  so the direction that matters most, a registrar passing a case to the
  consultant who will anaesthetise it, was not offered to either of them.

### Added

- **A member can hand a case to any colleague in their institution.** Until now
  only a head of department or an administrator could move a case, and only
  downwards. Handing a case on is an ordinary clinical act — a shift ends, or a
  pre-assessment is done days earlier by someone who will not be in that theatre
  — and refusing it did not stop it happening, it stopped the register seeing it.

  A member *asks*: the case, its number and every access rule stay exactly where
  they are until the recipient accepts, because the sender is usually still
  documenting it. A head of department *assigns*, unchanged, and it moves at
  once. The sender may withdraw an offer nobody has answered; `CANCELLED` is a
  distinct outcome from `DECLINED`, because "my colleague refused this" and "I
  thought better of it" are the two things anyone asks of a handover trail.

- `GET /v1/cases/{id}/transfers` — who has held a case and who moved it,
  readable by anyone who may open the case. The audit log has recorded this all
  along but only an administrator can read it, which answers a compliance
  question rather than a clinical one.

- `?direction=outgoing` on the pending-transfer list, so a sender can see an
  offer nobody has answered and reach the withdrawal at all.

- Audit actions `CASE_TRANSFER_REQUEST` and `CASE_TRANSFER_CANCEL`; every
  transfer action now records `fromUserId`, without which the losing owner was
  recoverable only from the transfer row.

## [9.2.2] - 2026-08-19

- **A diagnosis can be coded on a database with no imported vocabulary.**
  `scripts/seed-icd10-from-bundle.ts` fills `Icd10Code` from the offline
  vocabulary Core already ships — 16,175 codes with English and Bulgarian
  labels, the same rows the phone searches when it has no network.

  `/v1/search/icd10` reads that table and nothing else. Its two neighbours do
  not: `search/procedures` serves a bundled `pcs.json` and never touches the
  database, and `search/drugs` queries the database and falls back to a bundled
  `drugs.json` "for development databases before the Drug seed has run". ICD-10
  was the one route with no floor beneath it, so wherever the table was empty
  the diagnosis field returned nothing — and an empty dropdown reads as *no such
  code*, not *nothing is loaded*.

  Seeding rather than teaching the route a fallback keeps one code path: a
  fallback would run only where the database is empty, which is the deployment
  exercised least.

  Insert-only. An institution that has imported its approved package holds
  labels this bundle does not, and a reseed must never replace curated
  terminology with generic terminology in a table nothing validates against.
  Existing codes are left exactly as they are; `seed-vocabularies.ts` still
  upserts, so a licensed import always wins over the bundle.

## [9.2.1] - 2026-08-19

- **deepmerge-ts is held at 8.0.1.** CVE-2026-40345 is stack exhaustion from
  uncontrolled recursion: the merge functions have no cycle detection, so two
  objects that reference each other through the same property path recurse until
  the stack gives out and the process dies. Only 8.0.0 and later are patched —
  7.1.6 is not — and `@prisma/config` pins 7.1.5 exactly, so the version has to
  be forced from here.

  It arrives through `prisma.config.ts` being loaded rather than through any
  request, so nothing a clinician or an API caller can reach merges untrusted
  objects with it. The upgrade is not a judgement about that: a vulnerability
  with a fix available gets the fix, and reasoning about reachability instead is
  precisely what the appliance release policy refuses to accept.

## [9.2.0] - 2026-08-18

Five clinical-integrity fixes from an audit of the 1.0.0 appliance. They apply
to this deployment too, which is why they are here rather than in the appliance.

### Clinical record

- **Finalization records are append-only.** `CaseSnapshot` described itself as
  immutable, held `caseId @unique`, and was written with an upsert whose update
  branch replaced both the document and its timestamp. A
  finalize → unfinalize → edit → finalize cycle therefore destroyed the original
  attestation with no trace, and the surviving row kept the schemaVersion it was
  first created with over a document of a different shape.

  `CaseFinalization` appends instead: each finalization takes the next sequence,
  records who performed it, and for a correction why and which record it
  supersedes. A database trigger rejects UPDATE and DELETE, so the guarantee no
  longer depends on every future caller remembering it. Deleting the parent case
  still cascades, because that is the erasure path.

  The document is stored as text rather than JSONB. JSONB does not preserve key
  order, so a hash taken before storage could never be recomputed from what came
  back out — and an integrity check that cannot be run is worse than none.

  Existing snapshots migrate to sequence 1. `finalizedById` and `snapshotHash`
  stay null on them: those rows never recorded an actor and were never hashed,
  and a hash computed during the migration would attest to nothing while looking
  exactly like one taken at the time.

- **A case stays at the hospital that recorded it.** An administrator could
  transfer a case to a clinician at another institution, and the transfer
  rewrote the case's `institutionId` to the recipient's — so the record, the
  printed protocol and the OMOP `care_site` all said the operation had happened
  somewhere it had not.

  Cross-institution transfer is refused outright now, administrators included,
  comparing against the case's institution rather than the actor's. The
  institution is never rewritten, and the transfer helper asserts that rather
  than trusting its caller.

  Transferring a finalised case is refused as well: it is an attested record, so
  reassigning it means unfinalising it first.

### Audit

- **Audit entries commit with the acts they record.** Transfer, finalization,
  unfinalization and research access grants wrote theirs through
  `after(() => logAudit(...))` — which runs once the response has been sent,
  using a helper that swallows its own failures. An interruption between the
  commit and that callback left the change in place with nothing recording it.

  `logAuditInTransaction` writes through the caller's transaction and throws
  rather than swallowing: if the evidence cannot be written, the act it describes
  should not stand. `logAudit` remains for routine, high-volume records where
  losing an entry is survivable.

- **Every conflict override is recorded.** `forceUpdate` guarded nine conflict
  responses, and setting it erased any evidence that there had been a conflict at
  all — a colleague's edits were replaced with no error and nothing afterwards to
  show it. Any authenticated caller could set it, from the body or a header.

  The capability stays, because a queued offline save is stale by definition. It
  is named `overrideConflict` now and writes down which sections were
  overwritten, which revision the client believed it held, and which it
  discarded. Setting the flag when there was no conflict records nothing.

### Accounts

- **Deleting an account as an administrator soft-deletes it.** It was
  `prisma.user.delete()`. `Case.user` declares no `onDelete`, so Prisma defaults
  to Restrict and deleting any clinician holding a case raised a foreign-key
  error with no try/catch — an unhandled 500. The endpoint worked only for
  accounts with no clinical record.

  Where it did succeed it cascaded through nine relations, including
  `ResearchAccessGrant`, `ResearchCohort` and `ResearchExport`, destroying the
  record of what the account had been permitted to see.

  It now does what self-deletion already did: sets `deletedAt`, bumps
  `passwordChangedAt` so every existing token dies, and hands the account to the
  retention job. Until then the deletion is reversible, and the clinical records
  the account authored keep their author.

  Self-deletion was previously the only thing that set `deletedAt`, so the
  retention job had no input at all on a deployment where clinicians do not
  delete their own accounts.

- **`/v1/internal/purge-deleted` compares its bearer in constant time.** It used
  `===` while the research-export worker beside it used `timingSafeEqual` — on
  the endpoint that anonymises accounts.

### Database

Two migrations, applied on deploy:

- `20260818120000_append_only_finalization`
- `20260818160000_drop_include_exact_times`

## [9.1.1] - 2026-08-17

### Fixed

- **A clinical question answered "not asked" was rejected at the API boundary
  and dropped.**

  The request schema declared these fields as `z.boolean().optional()`, which
  accepts `undefined` and refuses `null`. 9.1.0 made the clients send an
  explicit null for an unasked question, so the lenient parser discarded every
  one of them and reported them as rejected fields.

  Nothing failed loudly. The case was created, the response was 201, and the
  answers were simply not there. The web form refused to advance past preop
  with "correct the rejected fields", and a client that ignored the rejection
  list lost the answer silently instead — which is the worse half.

  Seventeen declared fields now accept null. The RCRI, Apfel and STOP-BANG
  criteria were never declared and pass through untouched, so they were not
  affected.

  `emergencySurgery`, the "unobtainable" ticks and the other genuinely binary
  fields still refuse null, and a test pins that: a null there is a client bug
  and the API should keep saying so.

## [9.1.0] - 2026-08-16

### Changed

- Clinical yes/no questions can now record three answers: yes, no, and not
  asked. 29 columns become nullable.

  They were `Boolean @default(false)`, which cannot hold the distinction. An
  untouched field and a recorded "no" both reached the register as a documented
  negative, and on export the difference matters: a negative difficult-airway
  history is a finding, an unasked one is not, and a study that counts them
  together is counting something it did not measure.

  Existing rows are deliberately left as they are. Rewriting them to NULL would
  discard the genuine "no" answers among them, and nothing can tell those apart
  after the fact.

  `emergencySurgery` and `highRiskSurgery` stay boolean — not emergent means
  elective. So do the vitals "unobtainable" ticks and the monitoring and
  equipment flags, which are marks a clinician makes rather than questions put
  to a patient. The risk calculators still treat an unasked criterion as absent,
  since it must not count toward an RCRI, Apfel, STOP-BANG or POVOC score.

- OMOP export contract `source_version` 3.7.0 → 3.8.0.

### Fixed

- Allergies are no longer exported as drug administrations. `Medication.kind` is
  `CURRENT | ALLERGY` and the export iterated both, so a substance a patient
  reacts to was recorded as one they were given. Allergies now become
  observations.
- CARE_SITE is emitted as its own table and referenced by `care_site_id`,
  instead of the site being written onto every VISIT_OCCURRENCE as free text no
  OHDSI tool reads.
- Continuous administrations gain `drug_exposure_end_date`, paired from their
  stop events. An infusion with no end was indistinguishable from one still
  running.
- Every planned procedure is exported, not only the first.
- Intraoperative drugs resolve their ATC through the same concept pipeline as
  preoperative medications, instead of carrying the code unused beside a
  hardcoded concept id of 0.
- `drug_source_concept_id` holds a concept id or null, not the string
  `ATC:<code>`.
- Curated mappings on `CaseSelection`, `CaseComplication` and `VascularAccess`
  are read. The database held the mapping while the export said the row mapped
  to nothing.

### Added

- Airway management leaves the appliance: the device list, Cormack-Lehane grade,
  tools, per-device sizes and cuff status, DLT type/side/size, endobronchial
  size, ventilation modes, IPPV, jet ventilation and PEEP. None of it was
  exported before, so a case could say a tube was placed but not which, what
  size, or how difficult the view was.
- Placing an instrumented airway is emitted as a PROCEDURE_OCCURRENCE. A device
  is a state of the patient; putting it there is something done to them, and
  only the second belongs in a procedure count. A face mask produces no
  procedure, because nothing was placed.
- The preop findings that were read out of the database and written to no table:
  smoking, substance use, latex allergy, family anaesthesia history, dental
  state, cardiac arrhythmia, BMI, blood group and Rh, GUTA, and the airway
  examination — mouth opening, thyromental distance, neck mobility, upper lip
  bite test, retrognathia, prominent incisors and facial hair.
- MEASUREMENT gains `value_source_value`, `range_low` and `range_high`. A lab
  result with no parsed number was skipped entirely, so a culture, a dipstick or
  a blood group left no trace of having been recorded. Reference ranges now
  travel with the result: they differ by laboratory, assay and patient age, and
  "high" is not a claim an export can support without the range behind it.
- Vascular lines carry depth, lumen count and whether they were already in
  place. A pre-existing line was not placed during this case, so its procedure
  row overstated the work without that flag.
- `ConceptMappingStatus` gains `MANUALLY_CURATED` and `REJECTED`. MAPPED covered
  both an automatic match and one a human signed off; UNMAPPED covered both
  "nobody has looked" and "a candidate was rejected". A rejected mapping keeps
  its row so the rejection is remembered, but never applies its concept id.
- `mapping_summary` gains `manually_curated_rows` and `rejected_rows`.
- The procedure catalogue is seeded into the concept map. It was the one
  vocabulary the seed script never covered, so every planned procedure fell
  through to an implicit SOURCE_ONLY with no row behind it — a mapping that
  existed only as an absence.

### Migrations

- `20260816160000_tristate_clinical_questions`
- `20260816180000_concept_mapping_provenance`

Both are additive or relaxing and rewrite no data.

## [9.0.0] - 2026-08-11

### Breaking

- `/research/benchmarks` now rejects a metric it cannot plot instead of
  answering `null`. Nine of the fourteen metric ids had no evaluator; the
  endpoint accepted them, returned an empty series, and reported a real
  `caseCount` with `suppressed: false` alongside it. A client could not tell
  "nobody implemented this" from "no patients matched" or "withheld for a small
  cell size". Requests naming those nine now fail loudly.
- Requires `@lospor/core` v9.0.0, which makes
  `ResearchMetadata.supportedBenchmarkMetrics` mandatory.

### Added

- The capability response states `supportedBenchmarkMetrics`, the five metrics
  benchmarking can actually plot. `supportedMetrics` still lists all fourteen,
  which is correct — the aggregate path implements every one of them.
- OMOP observations carry `value_as_number`. Twenty-two scored variables — RCRI,
  Apfel, STOP-BANG, the Aldrete subscores and total, POVOC, COLDS, PAED, the
  paediatric pain scales, age, body surface area, duration, the fluid totals —
  were documented as numbers and written into the free-text column. The CSV
  writer now emits the column too; without that the numbers were dropped again
  at export time.
- Height and weight are exported, and every emitted variable now has a data
  dictionary entry under the name the export actually uses.

### Fixed

- The NRS pain score was emitted under OHDSI concept `3020891`, the standard
  concept for body temperature, copied from the vital map. Pooled, a pain score
  of 2 answered a temperature query as 2 °C. It now emits `0` and carries
  `LOINC:72514-3` as its source value.
- Seventeen documented ranges were narrower than the validator enforces — age
  0–120 against 149, SpO2 50–100 against 0–100, temperature 30–43 against
  25–45. A researcher filtering on the published range would have silently
  excluded real records.
- `DICTIONARY_VERSION` is 4.1.0, `source_version` 3.7.0, `schema_version` 3.6.0.

## [8.4.0] - 2026-08-06

### Changed

- `/v1/search/icd10` and `/v1/search/procedures` now rank through
  `@lospor/core/search` instead of keeping their own copies, so the offline
  vocabulary bundled into the mobile app returns identical results rather than
  similar ones.
- ICD-10 queries order by code explicitly. Without an `ORDER BY`, Postgres could
  return any rows it liked for a `take`, which made the result set
  unreproducible — and left no way to show that the offline copy agreed with it.

### Added

- `scripts/generate-vocabulary.mts` generates the offline vocabulary into
  `@lospor/core/vocabulary`, and `scripts/verify-vocabulary-parity.mts` checks a
  corpus of queries against the live database. Current result: 60/60 identical
  for ICD-10 across both languages, 20/20 identical procedure group lists.

## [8.3.2] - 2026-08-06

### Fixed

- A laboratory value the extractor could not convert is no longer labelled with
  the canonical unit. The value is still in whatever unit the report printed, so
  pairing it with the canonical one put a haematocrit of `0.41` on screen as
  `0.41 %` — a number and a unit that do not belong together, in an editable
  field a clinician would reasonably read as already reconciled. Unconverted
  rows now carry the source unit, or none when the report printed none.

## [8.3.1] - 2026-08-05

Requires `@lospor/core` v8.3.0.

### Added

- `/health/ready` reports whether this installation can send email:
  `"email": "configured" | "not-configured"`. Without a mail provider nobody can
  verify an address, and a verified address is a condition of signing in — so an
  installation with no `BREVO_API_KEY` accepts registrations and then strands
  every one of them. That failure was invisible: a warning in the logs nobody
  reads, and a 201 to the client as though all was well. Reported rather than
  enforced, because verifying accounts by hand is a legitimate deployment; only
  whether a key is present is disclosed, never the key.

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
