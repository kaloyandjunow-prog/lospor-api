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

The actor for a clinical-rules maintenance script is a named active clinical
administrator, not a system principal. The operator supplies
`PUBLISHING_ADMIN_EMAIL`; the script resolves it inside its own transaction and
refuses to run unless it identifies an `ADMIN` account that has not been
deleted.

A non-human principal was rejected because it cannot vouch for a maintenance
operation. Creating, appending to, or pruning a ruleset is something a person
chose to do at a particular moment, on a database whose state they inspected;
an automation identity would record only that the act happened, with nobody
answerable for it. The immutable, non-login `LOSPOR 1.2.0` release principal
attests to exactly one thing — the two exact source-controlled bundled adult v2
and pediatric v2 baselines shipped with the release — and has no authority
beyond them. Using it for a maintenance run would stretch that attestation to
cover content and timing it knows nothing about.

Five scripts are resolved on that basis, each writing a typed audit row inside
the same transaction as the change it describes:

- `scripts/create-platform-clinical-drafts.ts` — `CLINICAL_RULESET_CREATE`, one
  row per created draft, with the administrator also recorded as the draft's
  author.
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

The append and prune scripts write nothing on a dry run, so a dry run produces
no audit row.

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
