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
For the already actor-attributed bootstrap and publication/reset scripts, the
source gate proves that a typed audit row is inside the same transaction; the
PostgreSQL transaction contract supplies the database semantic. Disposable
E2E/smoke fixture setup and cleanup is outside the production evidence
boundary. Ordinary login/session issuance, pre-auth MFA challenge bookkeeping,
and routine high-volume case/view telemetry are also outside HAUD-01; governed
revocation and MFA completion remain inventoried.

## Unresolved actor-principal decision

These six scripts remain unchanged and explicitly fail the inventory's
HAUD-complete classification:

- `scripts/create-platform-clinical-drafts.ts`
- `scripts/create-pediatric-v2-platform-draft.ts`
- `scripts/append-pediatric-fluid-profiles-to-draft.ts`
- `scripts/append-pediatric-infusion-profiles-to-draft.ts`
- `scripts/prune-clinical-rulesets.ts`
- `scripts/seed-play-reviewer.ts`

The decision is between requiring the operator to name an existing
administrator (for example by explicit administrator email) or creating a
dedicated non-human system principal with a narrowly defined operator identity.
The first option attributes each run to a real accountable person but requires
operator credentials/selection. The second cleanly identifies automation but
adds a new principal lifecycle and policy. No script may invent actor identity
or falsely attribute an update to the affected account. The release-only
`LOSPOR 1.2.0` technical principal does not resolve this operator decision: it
can attest only to the two exact source-controlled 1.2.0 bundles and has no
authority to run maintenance or provision accounts.

## Client boundary

The Web and Mobile owner clients display and filter the API-owned bilingual
action catalog. They do not persist audit rows and are not an alternative
mutation authority. Hospital maintains its separate overlay inventory for the
three `HOSPITAL_OWNED` areas.
