# HAUD-01 durable governance inventory

`src/lib/audit-governance-inventory.ts` is the release authority for every
privilege, account, legal, research-access, and clinical-rules lifecycle
mutation owned by the public API. Its companion test,
`src/__tests__/audit-governance-inventory.test.ts`, is a release gate rather
than a documentation-only checklist.

The gate proves that every FORLCAUDEFIXES HAUD-01 requirement has a named
disposition, every owner mutation source uses the durable audit writer inside
its Prisma transaction, every action code belongs to the typed bilingual
registry, and every unit-testable transition has audit-failure injection
evidence. Source discovery fails when a governed-model mutation is added
without an inventory entry or a narrow, explained exclusion.

## Inventory dispositions

- `OWNER_TRANSACTIONAL` — the public API owns the mutation, and mutation plus
  audit row commit together.
- `PUBLIC_NO_MUTATION` — the public serverless product deliberately has no such
  lifecycle. The former generic approval endpoint is a `410` no-mutation
  tombstone because public members activate by verified email.
- `HOSPITAL_OWNED` — Hospital Status/API owns provisioning and recovery,
  Hospital research-grant control, or Central control-plane mutations. These
  operations are not exposed as public serverless mutation paths.
- `DECISION_BLOCKED` — implementation is intentionally unchanged until a
  truthful actor-principal policy is selected.

The matrix explicitly covers public registration and initial legal evidence;
first-administrator bootstrap; activation-link reissue and activation;
role-request submission and approval/rejection; Member/HOD and administrator
authority changes; account-kind changes; identity correction; institution move
and leave; password change and recovery; session revocation; administrator MFA
enrollment and recovery-code use; suspension/reactivation; self/admin deletion,
restore, and retention anonymization; legal refresh; research self-authorization
and grants; and clinical-rules create/edit/delete/replace/publish/select/clear.
The same inventory covers clean-install publication of the exact bundled adult
and pediatric baselines by the immutable, non-login `LOSPOR 1.2.0` release
principal. Installation, publication evidence, platform selection, and its
bounded audit rows share one serializable transaction.

## Rollback evidence and exact limit

Route/service tests inject a rejecting audit writer and prove that failure
propagates, no success response is returned, and post-commit cache/session/mail
publication does not run where that boundary exists. Those tests use a mocked
Prisma transaction and therefore cannot, by themselves, prove that PostgreSQL
undid the preceding mocked mutation.

`src/__tests__/audit-atomicity-postgres.test.ts` remains the authoritative
database proof. With `LOSPOR_POSTGRES_INTEGRATION=true` and `DATABASE_URL` set,
it proves both commit and rollback and includes a governed account-lifecycle
mutation whose deliberately invalid audit insert rolls the user change back.
It stays skipped in database-free runs.

Executable `main()` operator scripts cannot safely be imported into unit tests.
For the actor-attributed bootstrap, publication/reset, and clinical-rules
maintenance scripts, the source gate proves that a typed audit row is inside
the same transaction; the PostgreSQL transaction contract supplies the database
semantic. Disposable
E2E/smoke fixture setup and cleanup is outside the production evidence
boundary. Ordinary login/session issuance, pre-auth MFA challenge bookkeeping,
and routine high-volume case/view telemetry are also outside HAUD-01; governed
revocation and MFA completion remain inventoried.

## Actor-principal decision

A clinical-rules maintenance or publication run is always audited. It never
silently mutates clinical content, whichever database it is pointed at.

Who the row names depends on the target. Against a protected database — the
connection string, not the environment variable, decides that — the operator
must supply `PUBLISHING_ADMIN_EMAIL`, and the script resolves it inside its own
transaction to an `ADMIN` account that has not been deleted. Production is where
"who did this" has to be a person, answerable for content and timing on a
database whose state only they inspected.

Against any other database, an unnamed run is attributed to the immutable,
non-login `LOSPOR 1.2.0` release principal, exactly as the bundled adult v2 and
pediatric v2 baselines already are. Requiring a named administrator everywhere
was ceremony on the product owner's own build tooling, and ceremony that could
not be satisfied: a freshly seeded development database contains no `ADMIN`
account at all, so the scripts could not run on a clean machine.

`PUBLISHING_ADMIN_EMAIL` is honoured wherever it is supplied. Naming an
administrator is a deliberate act, so it is validated on an unprotected database
too, and an address that does not resolve to an active `ADMIN` always aborts the
run rather than falling back to the release principal.

The two are never confused in storage. A principal id occupies no `User`
foreign key: a preset, its publication evidence and its platform selection carry
either the administrator columns or the technical-principal columns, never a
principal id in a column that means "user". `AuditLog.userId` is deliberately
not a foreign key and carries either, alongside an `actorKind` of `ADMIN` or
`RELEASE` and the script that produced the row, so a reader can tell a person
from the release without resolving the id first.

Nothing on a hospital appliance runs these scripts. No install, update, seed or
deploy path invokes them; the bundled baselines that ship to hospitals are
installed by `scripts/provision-bundled-clinical-baselines.ts`, whose exact
immutable attribution to the release principal is unchanged.

One ordering consequence is worth naming. The bundled provisioner installs only
into a database that holds no trace of the release principal, so a machine that
has already had a maintenance script run against it unnamed will be refused, as
a partial state, rather than installed into. That is a development-machine
constraint: an appliance provisions the baselines at install and never runs
these scripts.

`src/lib/clinical-rules/maintenance-actor.ts` is the single implementation of
that rule and `src/lib/clinical-rules/maintenance-actor.test.ts` proves it. Five
scripts write a typed audit row inside the same transaction as the change it
describes:

- `scripts/create-platform-clinical-drafts.ts` — `CLINICAL_RULESET_CREATE`, one
  row per created draft, with the actor also recorded as the draft's author.
- `scripts/create-pediatric-v2-platform-draft.ts` —
  `CLINICAL_RULESET_CREATE`. The preset was previously created outside any
  transaction; the preset, its authorship and its audit row now commit
  together.
- `scripts/append-pediatric-fluid-profiles-to-draft.ts` and
  `scripts/append-pediatric-infusion-profiles-to-draft.ts` —
  `CLINICAL_RULESET_RULE_UPSERT`, one row for the append rather than one per
  rule, carrying the appended count and rule keys. The append is the operation
  a reader is looking for; a row per profile would bury it.
- `scripts/prune-clinical-rulesets.ts` — `CLINICAL_RULESET_PRUNE`, a new
  registry code. The row is written before the delete, in the same transaction,
  because `ClinicalPresetRule` cascades away with the preset and afterwards
  there is nothing left to describe. It records the preset key, clinical mode,
  version, status and rule count.

`scripts/reset-dev-clinical-rulesets.ts`,
`scripts/publish-adult-v2-platform-ruleset.ts` and
`scripts/promote-pediatric-v2-platform-ruleset.ts` follow the same rule.
`scripts/promote-pediatric-platform-ruleset.ts`, which promoted the superseded
pediatric v1, still demands a named administrator unconditionally.

A dry run writes nothing at all: no audit row, and no release-principal row
either. Where the dry run reaches the transaction it still resolves and
validates a named administrator, because that is one of the things a dry run is
for.

`scripts/seed-play-reviewer.ts` remains `DECISION_BLOCKED`. It provisions and
resets a live production credential rather than clinical content, so a clinical
administrator is not the right actor either, and self-attribution would falsely
record the reviewer as having changed their own password. It awaits a named
accountable operator identity or a maintenance principal kind with its own
lifecycle. The gate fails if it is quietly dropped.

## Client boundary

The Web and Mobile owner clients display and filter the API-owned bilingual
action catalog. They do not persist audit rows and are not an alternative
mutation authority. Hospital maintains its separate overlay inventory for the
three `HOSPITAL_OWNED` areas.
