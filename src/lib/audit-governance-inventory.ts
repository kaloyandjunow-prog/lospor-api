import type { AuditActionCode } from "@/lib/audit-actions"

/**
 * Release-gate inventory for HAUD-01.
 *
 * This is not runtime configuration. It is an executable ownership map used by
 * the source/contract test and the release documentation. Adding a governed
 * mutation requires adding it here, using the durable transaction writer, and
 * naming its rollback evidence. Entries that cannot yet name a truthful actor
 * remain explicitly decision-blocked instead of being silently exempted.
 */

export type AuditGovernanceRequirement =
  | "ACCOUNT_PROVISION"
  | "TOKEN_REISSUE"
  | "ACTIVATION"
  | "APPROVAL_REJECTION"
  | "ROLE_CHANGE"
  | "ADMIN_AUTHORITY"
  | "INSTITUTION_CHANGE"
  | "PASSWORD_CHANGE_RECOVERY"
  | "SESSION_REVOCATION"
  | "SUSPEND_REACTIVATE"
  | "DELETE_RESTORE_ANONYMISE"
  | "LEGAL_ACCEPTANCE"
  | "RESEARCH_ACCESS"
  | "CLINICAL_RULE_GOVERNANCE"
  | "CENTRAL_CONTROL"

export type AuditMutationSource = Readonly<{
  path: string
  actionCodes: readonly AuditActionCode[]
  auditPath: "TRANSACTION_HELPER" | "DIRECT_TRANSACTION_ROW"
}>

type OwnerTransactionalCoverage = Readonly<{
  id: string
  requirement: AuditGovernanceRequirement
  transition: string
  disposition: "OWNER_TRANSACTIONAL"
  sources: readonly AuditMutationSource[]
  rollback: Readonly<{
    kind: "UNIT_INJECTION" | "POSTGRES_INTEGRATION" | "SOURCE_ONLY_SCRIPT"
    evidencePath: string
    marker: string
  }>
  limit?: string
}>

type PublicNoMutationCoverage = Readonly<{
  id: string
  requirement: AuditGovernanceRequirement
  transition: string
  disposition: "PUBLIC_NO_MUTATION"
  evidencePath: string
  limit: string
}>

type HospitalOwnedCoverage = Readonly<{
  id: string
  requirement: AuditGovernanceRequirement
  transition: string
  disposition: "HOSPITAL_OWNED"
  limit: string
}>

type DecisionBlockedCoverage = Readonly<{
  id: string
  requirement: AuditGovernanceRequirement
  transition: string
  disposition: "DECISION_BLOCKED"
  blockedSources: readonly string[]
  limit: string
}>

export type AuditGovernanceCoverage =
  | OwnerTransactionalCoverage
  | PublicNoMutationCoverage
  | HospitalOwnedCoverage
  | DecisionBlockedCoverage

export const AUDIT_GOVERNANCE_INVENTORY = [
  {
    id: "public-account-registration",
    requirement: "ACCOUNT_PROVISION",
    transition: "Public self-registration provisions MEMBER and records its initial legal set",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/auth/register/route.ts",
      actionCodes: ["ACCOUNT_PROVISION", "LEGAL_ACCEPTANCE_RECORD"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/__tests__/auth-email.test.ts",
      marker: "HAUD_ROLLBACK:public-account-registration",
    },
  },
  {
    id: "bootstrap-first-administrator",
    requirement: "ACCOUNT_PROVISION",
    transition: "Fresh-install first administrator provisioning",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "scripts/bootstrap-admin.ts",
      actionCodes: ["ACCOUNT_PROVISION"],
      auditPath: "DIRECT_TRANSACTION_ROW",
    }],
    rollback: {
      kind: "SOURCE_ONLY_SCRIPT",
      evidencePath: "src/__tests__/audit-governance-inventory.test.ts",
      marker: "HAUD_SOURCE_ONLY:bootstrap-first-administrator",
    },
    limit: "The script cannot be imported safely as a unit: it executes main and requires PostgreSQL. The source gate and PostgreSQL transaction contract cover it.",
  },
  {
    id: "public-activation-link-reissue",
    requirement: "TOKEN_REISSUE",
    transition: "Revoke prior email-verification tokens and issue a replacement",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/auth/verify-email/resend/route.ts",
      actionCodes: ["ACCOUNT_ACTIVATION_TOKEN_REISSUE"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/__tests__/auth-email.test.ts",
      marker: "HAUD_ROLLBACK:public-activation-link-reissue",
    },
  },
  {
    id: "public-email-activation",
    requirement: "ACTIVATION",
    transition: "Claim a verification token and activate an ordinary MEMBER",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/auth/verify-email/route.ts",
      actionCodes: ["ACCOUNT_ACTIVATE"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/__tests__/auth-email.test.ts",
      marker: "HAUD_ROLLBACK:public-email-activation",
    },
  },
  {
    id: "public-generic-approval",
    requirement: "APPROVAL_REJECTION",
    transition: "Public account approval queue",
    disposition: "PUBLIC_NO_MUTATION",
    evidencePath: "src/app/v1/admin/users/[id]/approve/route.ts",
    limit: "Public accounts activate through verified email. The retired generic approval route is a 410 tombstone and performs no mutation.",
  },
  {
    id: "hospital-account-provision-activation-recovery",
    requirement: "APPROVAL_REJECTION",
    transition: "Hospital administrator provisioning, activation, rejection, and recovery-link lifecycle",
    disposition: "HOSPITAL_OWNED",
    limit: "Hospital Status/API overlay owns these mail-independent operations and their transactional audit; the public owner API does not expose them on the serverless demo.",
  },
  {
    id: "role-request-submit",
    requirement: "ROLE_CHANGE",
    transition: "Member submits a HOD role request",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/role-request/route.ts",
      actionCodes: ["ROLE_REQUEST_SUBMIT"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/role-request/route.test.ts",
      marker: "HAUD_ROLLBACK:role-request-submit",
    },
  },
  {
    id: "role-request-resolution",
    requirement: "APPROVAL_REJECTION",
    transition: "Administrator approves or rejects a HOD role request",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/admin/role-requests/[id]/route.ts",
      actionCodes: ["HOD_ROLE_REQUEST_APPROVE", "HOD_ROLE_REQUEST_REJECT"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/admin/authority-transition-routes.test.ts",
      marker: "HAUD_ROLLBACK:role-request-resolution",
    },
  },
  {
    id: "direct-member-hod-role-change",
    requirement: "ROLE_CHANGE",
    transition: "Administrator changes routine MEMBER/HOD authority",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/admin/users/[id]/route.ts",
      actionCodes: ["ADMIN_ACCOUNT_AUTHORITY_CHANGE"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/admin/users/[id]/route.test.ts",
      marker: "HAUD_ROLLBACK:direct-member-hod-role-change",
    },
  },
  {
    id: "administrator-authority-change",
    requirement: "ADMIN_AUTHORITY",
    transition: "Promote/demote administrator or change clinical/research account kind",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/admin/users/[id]/authority/route.ts",
      actionCodes: ["ADMIN_ACCOUNT_PROMOTE", "ADMIN_ACCOUNT_DEMOTE", "ADMIN_ACCOUNT_AUTHORITY_CHANGE"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/admin/users/[id]/authority/route.test.ts",
      marker: "HAUD_ROLLBACK:administrator-authority-change",
    },
  },
  {
    id: "profile-identity-correction",
    requirement: "ACCOUNT_PROVISION",
    transition: "Correct governed first name, last name, or professional title",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/user/route.ts",
      actionCodes: ["PROFILE_CORRECTION"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/__tests__/user-preferences-route.test.ts",
      marker: "HAUD_ROLLBACK:profile-identity-correction",
    },
  },
  {
    id: "institution-request-and-self-leave",
    requirement: "INSTITUTION_CHANGE",
    transition: "Submit an institution move or leave immediately for no-institution",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/user/institution-request/route.ts",
      actionCodes: ["INSTITUTION_CHANGE_REQUEST_SUBMIT", "INSTITUTION_CHANGE_SELF_LEAVE"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/user/institution-request/route.test.ts",
      marker: "HAUD_ROLLBACK:institution-request-and-self-leave",
    },
  },
  {
    id: "institution-request-resolution",
    requirement: "APPROVAL_REJECTION",
    transition: "Authorized administrator/HOD approves or rejects an institution move",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/admin/institution-requests/[id]/route.ts",
      actionCodes: ["INSTITUTION_CHANGE_APPROVE", "INSTITUTION_CHANGE_REJECT"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/admin/authority-transition-routes.test.ts",
      marker: "HAUD_ROLLBACK:institution-request-resolution",
    },
  },
  {
    id: "authenticated-password-change",
    requirement: "PASSWORD_CHANGE_RECOVERY",
    transition: "Change password, consume reset links, and revoke sessions",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/user/change-password/route.ts",
      actionCodes: ["PASSWORD_CHANGE"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/user/change-password/route.test.ts",
      marker: "HAUD_ROLLBACK:authenticated-password-change",
    },
  },
  {
    id: "password-recovery-link-issue",
    requirement: "TOKEN_REISSUE",
    transition: "Revoke prior reset tokens and issue a replacement",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/auth/password-reset/request/route.ts",
      actionCodes: ["PASSWORD_RECOVERY_TOKEN_ISSUE"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/__tests__/auth-email.test.ts",
      marker: "HAUD_ROLLBACK:password-recovery-link-issue",
    },
  },
  {
    id: "password-recovery-complete",
    requirement: "PASSWORD_CHANGE_RECOVERY",
    transition: "Claim reset token, change password, clear recovery state, and revoke sessions",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/auth/password-reset/confirm/route.ts",
      actionCodes: ["PASSWORD_RECOVERY"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/__tests__/auth-email.test.ts",
      marker: "HAUD_ROLLBACK:password-recovery-complete",
    },
  },
  {
    id: "session-revocation",
    requirement: "SESSION_REVOCATION",
    transition: "Revoke one session or every other session",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [
      {
        path: "src/app/v1/user/sessions/route.ts",
        actionCodes: ["SESSION_REVOKE_OTHERS"],
        auditPath: "TRANSACTION_HELPER",
      },
      {
        path: "src/app/v1/user/sessions/[id]/route.ts",
        actionCodes: ["SESSION_REVOKE"],
        auditPath: "TRANSACTION_HELPER",
      },
    ],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/user/sessions/route.test.ts",
      marker: "HAUD_ROLLBACK:session-revocation",
    },
  },
  {
    id: "administrator-mfa-state",
    requirement: "ADMIN_AUTHORITY",
    transition: "Enroll administrator MFA or consume a recovery code",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/auth/mfa/login/route.ts",
      actionCodes: ["ADMIN_MFA_ENROLL", "ADMIN_MFA_RECOVERY_CODE_USE"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/auth/mfa/login/route.test.ts",
      marker: "HAUD_ROLLBACK:administrator-mfa-state",
    },
  },
  {
    id: "administrator-suspend-reactivate",
    requirement: "SUSPEND_REACTIVATE",
    transition: "Suspend or reactivate an account",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [
      {
        path: "src/app/v1/admin/users/[id]/suspend/route.ts",
        actionCodes: ["ADMIN_ACCOUNT_SUSPEND"],
        auditPath: "TRANSACTION_HELPER",
      },
      {
        path: "src/app/v1/admin/users/[id]/reactivate/route.ts",
        actionCodes: ["ADMIN_ACCOUNT_REACTIVATE"],
        auditPath: "TRANSACTION_HELPER",
      },
    ],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/admin/users/[id]/lifecycle-routes.test.ts",
      marker: "HAUD_ROLLBACK:administrator-suspend-reactivate",
    },
  },
  {
    id: "account-delete-restore",
    requirement: "DELETE_RESTORE_ANONYMISE",
    transition: "Self/admin deletion request or administrator recovery restore",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [
      {
        path: "src/app/v1/user/delete/route.ts",
        actionCodes: ["ACCOUNT_DELETE_REQUEST"],
        auditPath: "TRANSACTION_HELPER",
      },
      {
        path: "src/app/v1/admin/users/[id]/route.ts",
        actionCodes: ["ADMIN_ACCOUNT_DELETE"],
        auditPath: "TRANSACTION_HELPER",
      },
      {
        path: "src/app/v1/admin/users/[id]/restore/route.ts",
        actionCodes: ["ADMIN_ACCOUNT_RESTORE"],
        auditPath: "TRANSACTION_HELPER",
      },
    ],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/user/delete/route.test.ts",
      marker: "HAUD_ROLLBACK:account-delete-restore",
    },
  },
  {
    id: "retention-anonymisation",
    requirement: "DELETE_RESTORE_ANONYMISE",
    transition: "Anonymize an account after the retention deadline",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/lib/purge-deleted.ts",
      actionCodes: ["ACCOUNT_ANONYMISED"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/lib/purge-deleted.test.ts",
      marker: "HAUD_ROLLBACK:retention-anonymisation",
    },
  },
  {
    id: "legal-acceptance-refresh",
    requirement: "LEGAL_ACCEPTANCE",
    transition: "Record a new exact Terms/Privacy acceptance set",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/user/legal-acceptances/route.ts",
      actionCodes: ["LEGAL_ACCEPTANCE_RECORD"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/user/legal-acceptances/route.test.ts",
      marker: "HAUD_ROLLBACK:legal-acceptance-refresh",
    },
  },
  {
    id: "research-self-authorization",
    requirement: "RESEARCH_ACCESS",
    transition: "Clinician self-authorizes aggregate query access",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/app/v1/research/self-authorization/route.ts",
      actionCodes: ["RESEARCH_SELF_AUTHORIZE"],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/research/self-authorization/route.test.ts",
      marker: "HAUD_ROLLBACK:research-self-authorization",
    },
  },
  {
    id: "public-research-grants",
    requirement: "RESEARCH_ACCESS",
    transition: "Create, change, or revoke an owner-API research grant",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [
      {
        path: "src/app/v1/research/grants/route.ts",
        actionCodes: ["RESEARCH_GRANT_CREATE"],
        auditPath: "TRANSACTION_HELPER",
      },
      {
        path: "src/app/v1/research/grants/[id]/route.ts",
        actionCodes: ["RESEARCH_GRANT_UPDATE", "RESEARCH_GRANT_REVOKE"],
        auditPath: "TRANSACTION_HELPER",
      },
    ],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/app/v1/research/grants/audit-rollback.test.ts",
      marker: "HAUD_ROLLBACK:public-research-grants",
    },
  },
  {
    id: "hospital-research-grants",
    requirement: "RESEARCH_ACCESS",
    transition: "Hospital research grants and dataset approvals through Status",
    disposition: "HOSPITAL_OWNED",
    limit: "Hospital retires the direct clinical-admin mutation surface and owns Status reauthentication, grant supersession/revocation, and exact dataset approval audit.",
  },
  {
    id: "clinical-rules-api-governance",
    requirement: "CLINICAL_RULE_GOVERNANCE",
    transition: "Create/edit/delete/replace/publish/select/clear an API-owned clinical ruleset",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/lib/clinical-rules/service.ts",
      actionCodes: [
        "CLINICAL_RULESET_CREATE",
        "CLINICAL_RULESET_RULE_UPSERT",
        "CLINICAL_RULESET_RULE_DELETE",
        "CLINICAL_RULESET_PEDIATRIC_DRUG_REPLACE",
        "CLINICAL_RULESET_PUBLISH",
        "CLINICAL_RULESET_SELECT",
        "CLINICAL_RULESET_SELECTION_CLEAR",
      ],
      auditPath: "TRANSACTION_HELPER",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/__tests__/clinical-rule-service.test.ts",
      marker: "HAUD_ROLLBACK:clinical-rules-api-governance",
    },
  },
  {
    id: "bundled-clinical-baseline-provision",
    requirement: "CLINICAL_RULE_GOVERNANCE",
    transition: "Install, publish, and select the exact adult-v2 and pediatric-v2 release baselines",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [{
      path: "src/lib/clinical-rules/bundled-baseline-provisioner.ts",
      actionCodes: ["CLINICAL_BUNDLED_BASELINE_PROVISION"],
      auditPath: "DIRECT_TRANSACTION_ROW",
    }],
    rollback: {
      kind: "UNIT_INJECTION",
      evidencePath: "src/lib/clinical-rules/bundled-baseline-provisioner.test.ts",
      marker: "HAUD_ROLLBACK:bundled-clinical-baseline-provision",
    },
    limit: "The release-only TechnicalPrincipal is immutable and non-login; it does not authorize maintenance scripts or account operations.",
  },
  {
    id: "clinical-rules-operator-publication",
    requirement: "CLINICAL_RULE_GOVERNANCE",
    transition: "Reviewed platform publication/reset scripts with an explicit administrator actor",
    disposition: "OWNER_TRANSACTIONAL",
    sources: [
      {
        path: "scripts/reset-dev-clinical-rulesets.ts",
        actionCodes: ["CLINICAL_RULESET_DEV_RESET"],
        auditPath: "DIRECT_TRANSACTION_ROW",
      },
      {
        path: "scripts/publish-adult-v2-platform-ruleset.ts",
        actionCodes: ["CLINICAL_RULESET_PUBLISH"],
        auditPath: "DIRECT_TRANSACTION_ROW",
      },
      {
        path: "scripts/promote-pediatric-platform-ruleset.ts",
        actionCodes: ["CLINICAL_RULESET_PUBLISH_AND_SELECT"],
        auditPath: "DIRECT_TRANSACTION_ROW",
      },
      {
        path: "scripts/promote-pediatric-v2-platform-ruleset.ts",
        actionCodes: ["CLINICAL_RULESET_PUBLISH_AND_SELECT"],
        auditPath: "DIRECT_TRANSACTION_ROW",
      },
    ],
    rollback: {
      kind: "SOURCE_ONLY_SCRIPT",
      evidencePath: "src/__tests__/audit-governance-inventory.test.ts",
      marker: "HAUD_SOURCE_ONLY:clinical-rules-operator-publication",
    },
    limit: "Guarded scripts execute main and require PostgreSQL; the source gate proves the audit row is inside their database transaction and the retained PostgreSQL suite proves rollback semantics.",
  },
  {
    id: "clinical-rules-no-actor-scripts",
    requirement: "CLINICAL_RULE_GOVERNANCE",
    transition: "Create/append/prune rulesets from guarded scripts that cannot yet name a truthful actor",
    disposition: "DECISION_BLOCKED",
    blockedSources: [
      "scripts/create-platform-clinical-drafts.ts",
      "scripts/create-pediatric-v2-platform-draft.ts",
      "scripts/append-pediatric-fluid-profiles-to-draft.ts",
      "scripts/append-pediatric-infusion-profiles-to-draft.ts",
      "scripts/prune-clinical-rulesets.ts",
    ],
    limit: "Awaiting the explicit-admin-email versus dedicated-system-principal decision. These scripts remain unchanged and must not be treated as HAUD-complete.",
  },
  {
    id: "play-reviewer-no-actor-script",
    requirement: "ACCOUNT_PROVISION",
    transition: "Provision or reset the production Google Play reviewer account",
    disposition: "DECISION_BLOCKED",
    blockedSources: ["scripts/seed-play-reviewer.ts"],
    limit: "CREATE could self-attribute, but UPDATE would falsely claim the reviewer acted. It awaits the same explicit-admin versus system-principal decision.",
  },
  {
    id: "hospital-central-control",
    requirement: "CENTRAL_CONTROL",
    transition: "Central policy, transport configuration, export approval, withdrawal, and retry control",
    disposition: "HOSPITAL_OWNED",
    limit: "Status/Hospital owns the separately reauthenticated Central control-plane mutations and their durable audit. No public serverless Central mutation exists.",
  },
] as const satisfies readonly AuditGovernanceCoverage[]
