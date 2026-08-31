import { readFileSync } from "node:fs"

const API_RELEASE_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version

const ref = name => ({ $ref: `#/components/schemas/${name}` })
const arrayOf = name => ({ type: "array", items: ref(name) })
const object = (properties = {}, required = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
})
const nullable = schema => ({ anyOf: [schema, { type: "null" }] })

export const schemas = {
  ApiError: object({
    error: { type: "string" },
    code: { type: "string" },
    requestId: { type: "string", format: "uuid" },
    details: {},
  }, ["error"]),
  Message: object({ message: { type: "string" }, ok: { type: "boolean" } }),
  ReadinessResponse: object({
    status: { type: "string", enum: ["ready", "unavailable"] },
    database: { type: "string", enum: ["ok", "error"] },
    email: { type: "string", enum: ["configured", "not-configured"] },
    legalDocuments: { type: "string", enum: ["configured", "unavailable", "unchecked"] },
    legalDeployment: { type: "string" },
    administratorMfa: { type: "string", enum: ["configured", "not-required", "unavailable", "unchecked"] },
  }, ["status", "database", "email", "legalDocuments", "administratorMfa"]),
  IdResponse: object({
    id: { type: "string" },
    caseCode: nullable({ type: "string" }),
    revision: { type: "integer", minimum: 0 },
  }, ["id"]),
  Pagination: object({
    total: { type: "integer", minimum: 0 },
    skip: { type: "integer", minimum: 0 },
    take: { type: "integer", minimum: 1 },
  }, ["total", "skip", "take"]),
  User: object({
    id: { type: "string" },
    email: nullable({ type: "string", format: "email" }),
    username: nullable({ type: "string", pattern: "^[A-Za-z][A-Za-z0-9._-]{2,63}$" }),
    name: { type: "string" },
    firstName: { type: "string" },
    lastName: { type: "string" },
    title: { type: "string" },
    role: { type: "string" },
    accountKind: { type: "string", enum: ["CLINICAL", "RESEARCH_ONLY"] },
    preferredLocale: { type: "string", enum: ["bg", "en"], default: "bg" },
    institutionId: nullable({ type: "string" }),
    preferences: { type: "object", additionalProperties: true },
  }, ["id", "email", "username", "name", "role", "accountKind", "preferredLocale"]),
  SessionUser: object({
    id: { type: "string" },
    email: nullable({ type: "string", format: "email" }),
    username: nullable({ type: "string", pattern: "^[A-Za-z][A-Za-z0-9._-]{2,63}$" }),
    name: { type: "string" },
    firstName: nullable({ type: "string" }),
    lastName: nullable({ type: "string" }),
    title: nullable({ type: "string" }),
    role: { type: "string" },
    accountKind: { type: "string", enum: ["CLINICAL", "RESEARCH_ONLY"] },
    preferredLocale: { type: "string", enum: ["bg", "en"], default: "bg" },
    institutionId: nullable({ type: "string" }),
    institutionName: nullable({ type: "string" }),
    jti: nullable({ type: "string" }),
    acceptedTermsAt: nullable({ type: "string", format: "date-time" }),
    legalAcceptances: { type: "array", items: ref("LegalAcceptanceRecord") },
    lastLoginAt: nullable({ type: "string", format: "date-time" }),
  }, ["id", "email", "username", "name", "firstName", "lastName", "title", "role", "accountKind", "preferredLocale", "institutionId", "institutionName", "acceptedTermsAt", "legalAcceptances", "lastLoginAt"]),
  AccountResponse: object({
    id: { type: "string" },
    email: nullable({ type: "string", format: "email" }),
    username: nullable({ type: "string", pattern: "^[A-Za-z][A-Za-z0-9._-]{2,63}$" }),
    name: { type: "string" },
    firstName: { type: "string" },
    lastName: { type: "string" },
    title: { type: "string" },
    role: { type: "string" },
    accountKind: { type: "string", enum: ["CLINICAL", "RESEARCH_ONLY"] },
    preferredLocale: { type: "string", enum: ["bg", "en"], default: "bg" },
    institutionId: nullable({ type: "string" }),
    institution: nullable(ref("AccountInstitution")),
    preferences: { type: "object", additionalProperties: true },
    clinicalPreferences: { type: "object", additionalProperties: true },
  }, ["id", "email", "username", "name", "firstName", "lastName", "title", "role", "accountKind", "preferredLocale", "institutionId", "institution", "preferences", "clinicalPreferences"]),
  AccountPatchResponse: object({
    ok: { type: "boolean", const: true },
    name: { type: "string" },
    firstName: { type: "string" },
    lastName: { type: "string" },
    title: { type: "string" },
    institution: nullable(ref("AccountInstitution")),
    preferences: { type: "object", additionalProperties: true },
    preferredLocale: { type: "string", enum: ["bg", "en"], default: "bg" },
  }, ["ok", "name", "firstName", "lastName", "title", "institution", "preferences", "preferredLocale"]),
  Colleague: object({
    id: { type: "string" },
    name: { type: "string" },
    title: { type: "string" },
    role: { type: "string" },
  }, ["id", "name", "title", "role"]),
  CaseAssigneeSummary: object({
    name: { type: "string" },
    institution: nullable(object({ name: { type: "string" } }, ["name"])),
  }, ["name", "institution"]),
  AdminUser: object({
    id: { type: "string" },
    email: nullable({ type: "string", format: "email" }),
    username: nullable({ type: "string", pattern: "^[A-Za-z][A-Za-z0-9._-]{2,63}$" }),
    name: { type: "string" },
    firstName: { type: "string" },
    lastName: { type: "string" },
    title: { type: "string" },
    role: { type: "string" },
    accountKind: { type: "string", enum: ["CLINICAL", "RESEARCH_ONLY"] },
    preferredLocale: { type: "string", enum: ["bg", "en"], default: "bg" },
    activatedAt: nullable({ type: "string", format: "date-time" }),
    emailVerifiedAt: nullable({ type: "string", format: "date-time" }),
    suspendedAt: nullable({ type: "string", format: "date-time" }),
    recoveryRequiredAt: nullable({ type: "string", format: "date-time" }),
    deletedAt: nullable({ type: "string", format: "date-time" }),
    anonymizedAt: nullable({ type: "string", format: "date-time" }),
    deletionDeadline: nullable({ type: "string", format: "date-time" }),
    status: { type: "string", enum: ["INVITED", "ACTIVE", "SUSPENDED", "DELETION_PENDING", "RECOVERY_REQUIRED"] },
    lastLoginAt: nullable({ type: "string", format: "date-time" }),
    passwordChangedAt: nullable({ type: "string", format: "date-time" }),
    legalCurrent: nullable({ type: "boolean" }),
    legalAcceptances: { type: "array", items: ref("LegalAcceptanceRecord") },
    createdAt: { type: "string", format: "date-time" },
    institution: nullable(object({
      id: { type: "string" },
      name: { type: "string" },
      city: { type: "string" },
    }, ["id", "name", "city"])),
  }, ["id", "email", "username", "name", "firstName", "lastName", "title", "role", "accountKind", "preferredLocale", "activatedAt", "emailVerifiedAt", "suspendedAt", "recoveryRequiredAt", "deletedAt", "status", "createdAt", "lastLoginAt", "passwordChangedAt", "legalCurrent", "legalAcceptances", "institution"]),
  AdminAccountUpdateResponse: object({
    id: { type: "string" },
    role: { type: "string" },
    accountKind: { type: "string", enum: ["CLINICAL", "RESEARCH_ONLY"] },
    reauthenticationRequired: { type: "boolean" },
  }, ["id", "role", "accountKind", "reauthenticationRequired"]),
  Institution: object({
    id: { type: "string" },
    name: { type: "string" },
    city: { type: "string" },
    country: { type: "string" },
  }, ["id", "name", "city", "country"]),
  AccountInstitution: object({
    id: { type: "string" },
    name: { type: "string" },
    city: { type: "string" },
  }, ["id", "name", "city"]),
  CaseInstitutionSummary: object({
    name: { type: "string" },
    city: { type: "string" },
  }, ["name", "city"]),
  PublicLoginRequest: object({
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 1 },
    locale: { type: "string", enum: ["bg", "en"] },
    deviceLabel: { type: "string", maxLength: 120 },
  }, ["email", "password"]),
  HospitalLoginRequest: object({
    username: {
      type: "string",
      minLength: 3,
      maxLength: 64,
      pattern: "^[A-Za-z][A-Za-z0-9._-]{2,63}$",
    },
    password: { type: "string", minLength: 1 },
    locale: { type: "string", enum: ["bg", "en"] },
    deviceLabel: { type: "string", maxLength: 120 },
  }, ["username", "password"]),
  LoginRequest: {
    oneOf: [ref("PublicLoginRequest"), ref("HospitalLoginRequest")],
    description: "Exactly one deployment-selected login identity. Email is public-only; username is trusted-Hospital-only.",
  },
  MfaChallenge: object({
    code: { type: "string", enum: ["MFA_REQUIRED", "MFA_ENROLLMENT_REQUIRED"] },
    challengeToken: { type: "string", minLength: 32, maxLength: 256 },
    expiresIn: { type: "integer", const: 300 },
    enrollmentRequired: { type: "boolean" },
    manualKey: { type: "string", pattern: "^[A-Z2-7]{32}$" },
    otpauthUri: { type: "string", format: "uri", pattern: "^otpauth://totp/" },
  }, ["code", "challengeToken", "expiresIn", "enrollmentRequired"]),
  MfaChallengeResponse: object({
    code: { type: "string", enum: ["MFA_REQUIRED", "MFA_ENROLLMENT_REQUIRED"] },
    mfa: ref("MfaChallenge"),
  }, ["code", "mfa"]),
  MfaLoginContinuationRequest: object({
    challengeToken: { type: "string", minLength: 32, maxLength: 256 },
    code: { type: "string", minLength: 6, maxLength: 64 },
  }, ["challengeToken", "code"]),
  PasswordChangeRequest: object({
    currentPassword: { type: "string", minLength: 1 },
    newPassword: { type: "string", minLength: 8 },
  }, ["currentPassword", "newPassword"]),
  PasswordChangeResponse: object({
    ok: { type: "boolean", const: true },
    reauthenticationRequired: { type: "boolean", const: true },
  }, ["ok", "reauthenticationRequired"]),
  AuthSession: object({
    id: { type: "string" },
    clientType: { type: "string", enum: ["WEB", "PWA", "NATIVE"] },
    deviceLabel: { type: "string" },
    issuedAt: { type: "string", format: "date-time" },
    lastSeenAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" },
    current: { type: "boolean" },
  }, ["id", "clientType", "deviceLabel", "issuedAt", "lastSeenAt", "expiresAt", "current"]),
  AuthSessionList: object({
    sessions: { type: "array", items: ref("AuthSession") },
  }, ["sessions"]),
  SessionRevocationResponse: object({
    ok: { type: "boolean", const: true },
    revokedCount: { type: "integer", minimum: 0 },
  }, ["ok", "revokedCount"]),
  LocaleResponse: object({
    locale: { type: "string", enum: ["bg", "en"], default: "bg" },
  }, ["locale"]),
  LegalDocumentReference: object({
    kind: { type: "string", enum: ["TERMS", "PRIVACY"] },
    version: { type: "string", minLength: 1 },
    effectiveDate: { type: "string", format: "date" },
    locale: { type: "string", enum: ["bg", "en"] },
    contentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    deployment: { type: "string", minLength: 1 },
  }, ["kind", "version", "effectiveDate", "locale", "contentSha256", "deployment"]),
  LegalDocument: {
    allOf: [
      ref("LegalDocumentReference"),
      object({ content: { type: "string", minLength: 1 } }, ["content"]),
    ],
  },
  LegalAcceptanceRecord: {
    allOf: [
      ref("LegalDocumentReference"),
      object({ acceptedAt: { type: "string", format: "date-time" } }, ["acceptedAt"]),
    ],
  },
  LegalAcceptancesRequest: object({
    acceptances: { type: "array", minItems: 2, maxItems: 2, items: ref("LegalDocumentReference") },
  }, ["acceptances"]),
  LegalAcceptancesGetResponse: object({
    acceptances: { type: "array", items: ref("LegalAcceptanceRecord") },
  }, ["acceptances"]),
  LegalAcceptancesMutationResponse: object({
    ok: { type: "boolean" },
    acceptances: { type: "array", items: ref("LegalDocumentReference") },
  }, ["ok", "acceptances"]),
  LegalDocumentsResponse: object({
    locale: { type: "string", enum: ["bg", "en"] },
    documents: { type: "array", minItems: 2, maxItems: 2, items: ref("LegalDocument") },
  }, ["locale", "documents"]),
  RegisterRequest: object({
    title: { type: "string" },
    firstName: { type: "string", minLength: 1 },
    lastName: { type: "string", minLength: 1 },
    email: { type: "string", format: "email" },
    institutionId: { type: "string" },
    locale: { type: "string", enum: ["bg", "en"] },
    legalAcceptances: { type: "array", minItems: 2, maxItems: 2, items: ref("LegalDocumentReference") },
    password: { type: "string", minLength: 8 },
  }, ["firstName", "lastName", "email", "institutionId", "legalAcceptances", "password"]),
  RegisterResponse: object({
    id: { type: "string" },
    email: { type: "string", format: "email" },
    verificationRequired: { type: "boolean", const: true },
    emailSent: { type: "boolean" },
    devVerifyUrl: { type: "string", format: "uri" },
  }, ["id", "email", "verificationRequired", "emailSent"]),
  EmailRequest: object({ email: { type: "string", format: "email" } }, ["email"]),
  PasswordResetConfirmRequest: object({
    token: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 8 },
  }, ["token", "password"]),
  TokenResponse: object({
    access_token: { type: "string" },
    token_type: { type: "string", const: "Bearer" },
    expires_in: { type: "integer", minimum: 1 },
    preferredLocale: { type: "string", enum: ["bg", "en"], default: "bg" },
  }, ["access_token", "token_type", "expires_in", "preferredLocale"]),
  SessionResponse: object({ user: ref("SessionUser") }, ["user"]),
  MfaWebLoginContinuationResponse: object({
    user: ref("SessionUser"),
    recoveryCodes: {
      type: "array",
      minItems: 10,
      maxItems: 10,
      items: { type: "string", pattern: "^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$" },
    },
  }, ["user"]),
  MfaNativeLoginContinuationResponse: object({
    access_token: { type: "string" },
    token_type: { type: "string", const: "Bearer" },
    expires_in: { type: "integer", minimum: 1 },
    preferredLocale: { type: "string", enum: ["bg", "en"], default: "bg" },
    recoveryCodes: {
      type: "array",
      minItems: 10,
      maxItems: 10,
      items: { type: "string", pattern: "^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$" },
    },
  }, ["access_token", "token_type", "expires_in", "preferredLocale"]),
  MfaLoginContinuationResponse: {
    oneOf: [
      ref("MfaWebLoginContinuationResponse"),
      ref("MfaNativeLoginContinuationResponse"),
    ],
  },
  CaseSection: { type: "object", additionalProperties: true },
  PreopCaseSection: {
    type: "object",
    properties: {
      ageValue: nullable({ type: "integer", minimum: 0 }),
      ageUnit: nullable({ type: "string", enum: ["DAYS", "MONTHS", "YEARS"] }),
    },
    additionalProperties: true,
  },
  CaseCreateRequest: object({
    clinicalMode: { type: "string", enum: ["ADULT", "PEDIATRIC"], default: "ADULT" },
    clinicalRulesVersion: nullable({ type: "string" }),
    notes: nullable({ type: "string", maxLength: 1000 }),
    preop: ref("PreopCaseSection"),
    intraop: ref("CaseSection"),
    postop: ref("CaseSection"),
  }, ["preop"]),
  CasePatchRequest: object({
    status: { type: "string", enum: ["DRAFT", "IN_PROGRESS", "AWAITING_REVIEW"] },
    notes: nullable({ type: "string", maxLength: 1000 }),
    clinicalMode: { type: "string", enum: ["ADULT", "PEDIATRIC"] },
    clinicalRulesVersion: nullable({ type: "string" }),
    preop: ref("PreopCaseSection"),
    intraop: ref("CaseSection"),
    postop: ref("CaseSection"),
    forceUpdate: { type: "boolean" },
  }),
  CaseSummary: object({
    id: { type: "string" },
    caseCode: nullable({ type: "string" }),
    userId: { type: "string" },
    createdById: { type: "string" },
    clinicalMode: { type: "string", enum: ["ADULT", "PEDIATRIC"] },
    clinicalRulesVersion: nullable({ type: "string" }),
    status: { type: "string", enum: ["DRAFT", "IN_PROGRESS", "AWAITING_REVIEW", "COMPLETE"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    preop: nullable(ref("PreopCaseSection")),
    intraop: nullable(ref("CaseSection")),
    postop: nullable(ref("CaseSection")),
    capabilities: object({
      canRead: { type: "boolean" },
      canWrite: { type: "boolean" },
      isCreator: { type: "boolean" },
      isAssignee: { type: "boolean" },
    }, ["canRead", "canWrite", "isCreator", "isAssignee"]),
  }, ["id", "userId", "createdById", "status", "createdAt", "updatedAt", "capabilities"]),
  CaseDetail: {
    allOf: [
      ref("CaseSummary"),
      { type: "object", properties: {
        notes: nullable({ type: "string" }),
        institution: nullable(ref("CaseInstitutionSummary")),
        user: ref("CaseAssigneeSummary"),
      }, additionalProperties: true },
    ],
  },
  CaseListResponse: object({
    cases: arrayOf("CaseSummary"),
    total: { type: "integer", minimum: 0 },
    skip: { type: "integer", minimum: 0 },
    take: { type: "integer", minimum: 1 },
  }, ["cases", "total", "skip", "take"]),
  CaseMutationResponse: object({
    id: { type: "string" },
    caseCode: nullable({ type: "string" }),
    clinicalMode: { type: "string", enum: ["ADULT", "PEDIATRIC"] },
    clinicalRulesVersion: nullable({ type: "string" }),
    preopUpdatedAt: { type: "string", format: "date-time" },
    preopRevision: { type: "integer", minimum: 0 },
    rejectedFields: { type: "array", items: object({
      path: { type: "string" },
      reason: { type: "string" },
    }, ["path"]) },
  }, ["id"]),
  CaseVersion: object({
    updatedAt: { type: "string", format: "date-time" },
    status: { type: "string", enum: ["DRAFT", "IN_PROGRESS", "AWAITING_REVIEW", "COMPLETE"] },
    clinicalRevision: { type: "integer", minimum: 0 },
    eventRevision: { type: "integer", minimum: 0 },
    relationalRevision: { type: "integer", minimum: 0 },
    preopUpdatedAt: nullable({ type: "string", format: "date-time" }),
    intraopUpdatedAt: nullable({ type: "string", format: "date-time" }),
    postopUpdatedAt: nullable({ type: "string", format: "date-time" }),
    preopRevision: nullable({ type: "integer", minimum: 0 }),
    intraopRevision: nullable({ type: "integer", minimum: 0 }),
    postopRevision: nullable({ type: "integer", minimum: 0 }),
  }, ["updatedAt", "status", "clinicalRevision", "eventRevision", "relationalRevision", "preopUpdatedAt", "intraopUpdatedAt", "postopUpdatedAt", "preopRevision", "intraopRevision", "postopRevision"]),
  LockRequest: object({ deviceId: { type: "string", minLength: 1, maxLength: 256 } }, ["deviceId"]),
  LockReleaseRequest: object({
    deviceId: { type: "string", minLength: 1, maxLength: 256 },
    force: { type: "boolean" },
  }),
  LockResponse: object({
    acquired: { type: "boolean" },
    locked: { type: "boolean" },
    yours: { type: "boolean" },
    extended: { type: "boolean" },
    holderName: nullable({ type: "string" }),
  }, ["acquired", "locked"]),
  ReleaseResponse: object({ released: { type: "boolean" }, forced: { type: "boolean" } }, ["released"]),
  Event: {
    type: "object",
    required: ["type", "ts"],
    properties: {
      id: { type: "string" },
      ts: { type: "string", format: "date-time" },
      type: { type: "string", minLength: 1, maxLength: 64 },
      name: { type: "string", maxLength: 200 },
      label: { type: "string", maxLength: 200 },
      dose: { oneOf: [{ type: "string" }, { type: "number" }] },
      unit: { type: "string", maxLength: 40 },
      rate: { oneOf: [{ type: "string" }, { type: "number" }] },
      volume: { oneOf: [{ type: "string" }, { type: "number" }] },
      category: { type: "string", maxLength: 80 },
      fluidId: { type: "string", minLength: 1, maxLength: 200 },
      fluidEntryMode: { type: "string", enum: ["VOLUME", "RATE"] },
      bagVolumeMl: { type: "number", minimum: 0, maximum: 1000000 },
      administeredVolumeMl: { type: "number", minimum: 0, maximum: 1000000 },
      drugRoute: { type: "string", maxLength: 40 },
      concentration: { type: "string", maxLength: 80 },
      concentrationValue: { type: "number", minimum: 0 },
      concentrationUnit: { type: "string", enum: ["PERCENT", "MCG_PER_ML", "MG_PER_ML", "IU_PER_ML", "MMOL_PER_ML", "MEQ_PER_ML"] },
      formulation: { type: "string", enum: ["HYPOBARIC", "ISOBARIC", "HYPERBARIC"] },
      calculationBasis: { type: "string", enum: ["FLAT", "NONE", "TBW", "IBW", "BSA_M2"] },
      calculationWeightKg: { type: "number", exclusiveMinimum: 0 },
      calculationMethod: { type: "string", minLength: 1, maxLength: 80 },
      clinicalRuleKey: { type: "string", minLength: 1, maxLength: 240 },
      clinicalRuleVersion: { type: "string", minLength: 1, maxLength: 160 },
      clinicalRuleSourceIds: {
        type: "array",
        maxItems: 64,
        items: { type: "string", minLength: 1, maxLength: 240 },
      },
      clinicalPresetId: { type: "string", minLength: 1, maxLength: 240 },
      clinicalPresetVersion: { type: "integer", minimum: 1 },
      clinicalPresetScope: { type: "string", enum: ["PLATFORM", "INSTITUTION", "USER"] },
    },
    additionalProperties: true,
  },
  EventMutationResponse: object({
    event: ref("Event"),
    revision: { type: "integer", minimum: 0 },
    updatedAt: { type: "string", format: "date-time" },
  }),
  TransferRequest: object({ toUserId: { type: "string", minLength: 1 } }, ["toUserId"]),
  TransferDecisionRequest: object({
    action: { type: "string", enum: ["accept", "decline"] },
  }, ["action"]),
  Transfer: object({
    id: { type: "string" },
    caseId: { type: "string" },
    fromUserId: { type: "string" },
    toUserId: { type: "string" },
    status: { type: "string", enum: ["PENDING", "ACCEPTED", "DECLINED"] },
    createdAt: { type: "string", format: "date-time" },
  }, ["id", "caseId", "fromUserId", "toUserId", "status"]),
  SearchResult: object({
    id: { type: "string" },
    code: { type: "string" },
    label: { type: "string" },
    labelEn: { type: "string" },
    labelBg: { type: "string" },
    group: { type: "string" },
    domain: { type: "string" },
  }),
  LibraryOption: object({
    id: { type: "string" },
    category: { type: "string" },
    value: { type: "string" },
    label: { type: "string" },
    parentId: nullable({ type: "string" }),
    active: { type: "boolean" },
    metadata: { type: "object", additionalProperties: true },
  }, ["id", "category", "value", "label"]),
  PediatricCapabilities: object({
    enabled: { type: "boolean" },
    productionReady: { type: "boolean" },
    minimumClientVersion: { type: "string" },
    rulesetVersion: { type: "string" },
  }, ["enabled", "productionReady", "minimumClientVersion", "rulesetVersion"]),
  Capabilities: object({
    apiVersion: { type: "string" },
    serviceVersion: { type: "string" },
    catalogVersion: { type: "string" },
    minimumSupportedClients: { type: "object", additionalProperties: { type: "string" } },
    compatibilityPaths: { type: "object", additionalProperties: { type: "string" } },
    support: object({
      configured: { type: "boolean" },
      contactUrl: nullable({ type: "string", format: "uri" }),
    }, ["configured", "contactUrl"]),
    authentication: object({
      loginIdentifier: { type: "string", enum: ["EMAIL", "USERNAME"] },
      selfRegistration: { type: "boolean" },
      passwordRecovery: { type: "string", enum: ["EMAIL", "ADMINISTRATOR", "UNAVAILABLE"] },
      passwordChange: { type: "boolean" },
      sessionInventory: { type: "boolean" },
    }, ["loginIdentifier", "selfRegistration", "passwordRecovery", "passwordChange", "sessionInventory"]),
    features: { type: "object", additionalProperties: true },
  }),
  PediatricCalculationRequest: {
    oneOf: [
      object({
        kind: { type: "string", const: "MOSTELLER_BSA" },
        inputs: object({
          heightCm: { type: "number", exclusiveMinimum: 0 },
          weightKg: { type: "number", exclusiveMinimum: 0 },
        }, ["heightCm", "weightKg"]),
      }, ["kind", "inputs"]),
      object({
        kind: { type: "string", const: "MAINTENANCE_FLUID" },
        inputs: object({
          weightKg: { type: "number", exclusiveMinimum: 0 },
          age: nullable(object({
            value: { type: "number", minimum: 0 },
            unit: { type: "string", enum: ["DAYS", "MONTHS", "YEARS"] },
          }, ["value", "unit"])),
        }, ["weightKg"]),
      }, ["kind", "inputs"]),
      object({
        kind: { type: "string", const: "RCUK_RESUSCITATION" },
        inputs: object({
          weightKg: { type: "number", exclusiveMinimum: 0 },
        }, ["weightKg"]),
      }, ["kind", "inputs"]),
    ],
  },
  PediatricCalculation: object({
    id: { type: "string" },
    caseId: { type: "string" },
    kind: { type: "string", enum: ["MOSTELLER_BSA", "MAINTENANCE_FLUID", "RCUK_RESUSCITATION"] },
    inputs: { type: "object", additionalProperties: true },
    outputs: { type: "object", additionalProperties: true },
    ruleVersion: { type: "string" },
    sourceRefs: { type: "array", items: { type: "string" } },
    acceptedBy: nullable({ type: "string" }),
    acceptedAt: nullable({ type: "string", format: "date-time" }),
    createdAt: { type: "string", format: "date-time" },
  }, ["id", "caseId", "kind", "inputs", "outputs", "ruleVersion", "sourceRefs", "createdAt"]),
  RoleRequest: object({
    id: { type: "string" },
    userId: { type: "string" },
    status: { type: "string" },
    requestedAt: { type: "string", format: "date-time" },
    resolvedAt: nullable({ type: "string", format: "date-time" }),
    targetReauthenticationRequired: { type: "boolean" },
  }, ["id", "userId", "status"]),
  InstitutionChangeRequest: object({
    id: { type: "string" },
    userId: { type: "string" },
    requestedInstitutionId: { type: "string" },
    previousInstitutionId: nullable({ type: "string" }),
    status: { type: "string" },
    requestedAt: { type: "string", format: "date-time" },
    resolvedAt: nullable({ type: "string", format: "date-time" }),
    resolvedById: nullable({ type: "string" }),
    targetReauthenticationRequired: { type: "boolean" },
  }, ["id", "userId", "requestedInstitutionId", "status"]),
  AuditLog: object({
    id: { type: "string" },
    action: { type: "string" },
    entityId: { type: "string" },
    detail: {},
    createdAt: { type: "string", format: "date-time" },
    user: ref("JsonObject"),
  }, ["id", "action", "entityId", "createdAt", "user"]),
  AuditActionDefinition: object({
    code: { type: "string" },
    category: {
      type: "string",
      enum: ["ACCOUNT", "AUTHENTICATION", "CASE", "CLINICAL_RULES", "INSTITUTION", "MAINTENANCE", "RESEARCH", "SECURITY"],
    },
    labels: object({
      bg: { type: "string" },
      en: { type: "string" },
    }, ["bg", "en"]),
  }, ["code", "category", "labels"]),
  AuditLogPage: object({
    logs: arrayOf("AuditLog"),
    total: { type: "integer", minimum: 0 },
    page: { type: "integer", minimum: 0 },
    pageSize: { type: "integer", minimum: 1 },
    actions: arrayOf("AuditActionDefinition"),
  }, ["logs", "total", "page", "pageSize", "actions"]),
  ExportLimitError: object({
    error: { type: "string" },
    code: { type: "string", const: "EXPORT_LIMIT_EXCEEDED" },
    matchingCases: { type: "integer", minimum: 0 },
    exportedCases: { type: "integer", const: 0 },
    exportLimit: { type: "integer", const: 5000 },
    complete: { type: "boolean", const: false },
  }, ["error", "code", "matchingCases", "exportedCases", "exportLimit", "complete"]),
  ResearchNumberRange: object({
    min: { type: "number" },
    max: { type: "number" },
  }),
  ResearchDateRange: object({
    from: { type: "string", format: "date" },
    to: { type: "string", format: "date" },
  }),
  ResearchCohortFilters: object({
    statuses: { type: "array", items: { type: "string", enum: ["DRAFT", "IN_PROGRESS", "AWAITING_REVIEW", "COMPLETE"] } },
    clinicalModes: { type: "array", items: { type: "string", enum: ["ADULT", "PEDIATRIC"] } },
    finalized: ref("ResearchDateRange"),
    ageDays: ref("ResearchNumberRange"),
    ageYears: ref("ResearchNumberRange"),
    bmi: ref("ResearchNumberRange"),
    durationMinutes: ref("ResearchNumberRange"),
    aldreteTotal: ref("ResearchNumberRange"),
    painScore: ref("ResearchNumberRange"),
    sex: { type: "array", items: { type: "string" } },
    asa: { type: "array", items: { type: "string" } },
    emergency: { type: "boolean" },
    highRisk: { type: "boolean" },
    ponv: { type: "boolean" },
    diagnosisCodes: { type: "array", items: { type: "string" } },
    diagnosisText: { type: "string" },
    comorbidityCodes: { type: "array", items: { type: "string" } },
    comorbidityText: { type: "string" },
    procedureCodes: { type: "array", items: { type: "string" } },
    procedureText: { type: "string" },
    procedureGroups: { type: "array", items: { type: "string" } },
    techniques: { type: "array", items: { type: "string" } },
    positions: { type: "array", items: { type: "string" } },
    airwayDevices: { type: "array", items: { type: "string" } },
    monitoring: { type: "array", items: { type: "string" } },
    medications: { type: "array", items: { type: "string" } },
    atcCodes: { type: "array", items: { type: "string" } },
    complications: { type: "array", items: { type: "string" } },
    dispositions: { type: "array", items: { type: "string" } },
    mappingStatuses: { type: "array", items: { type: "string" } },
    minimumCompleteness: { type: "number", minimum: 0, maximum: 100 },
  }),
  ResearchCohort: object({
    version: { type: "integer", const: 1 },
    filters: ref("ResearchCohortFilters"),
  }, ["version", "filters"]),
  ResearchQueryRequest: object({
    cohort: ref("ResearchCohort"),
  ResearchPaginationRequest: object({
    skip: { type: "integer", minimum: 0, default: 0 },
    take: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  }),
  ResearchPagination: object({
    total: { type: "integer", minimum: 0 },
    skip: { type: "integer", minimum: 0 },
    take: { type: "integer", minimum: 1, maximum: 200 },
    hasMore: { type: "boolean" },
  }, ["total", "skip", "take", "hasMore"]),
  ResearchSort: object({
    field: { type: "string", enum: ["finalizedAt", "ageYears", "ageDays", "durationMinutes", "asa"] },
    direction: { type: "string", enum: ["asc", "desc"] },
  }, ["field", "direction"]),
    savedCohortId: { type: "string", minLength: 1 },
    pagination: ref("ResearchPaginationRequest"),
    metrics: { type: "array", items: { type: "string", enum: ["caseCount", "pediatricRate", "meanAgeYears", "meanAgeDays", "meanBmi", "meanDurationMinutes", "emergencyRate", "highRiskRate", "complicationRate", "ponvRate", "meanAldrete", "meanPainScore", "mappingCoverage", "fieldCompleteness"] } },
    distributions: { type: "array", items: { type: "string", enum: ["sex", "asa", "status", "clinicalMode", "procedure", "diagnosis", "technique", "airway", "disposition", "complication"] } },
    sort: ref("ResearchSort"),
  }, ["cohort"]),
  ResearchCountDisclosure: object({
    value: nullable({ type: "integer", minimum: 0 }),
    lowerBound: { type: "integer", minimum: 0 },
    upperBound: nullable({ type: "integer", minimum: 0 }),
    exact: { type: "boolean" },
    suppressed: { type: "boolean" },
  }, ["value", "lowerBound", "upperBound", "exact", "suppressed"]),
  ResearchMetric: object({
    id: { type: "string", enum: ["caseCount", "pediatricRate", "meanAgeYears", "meanAgeDays", "meanBmi", "meanDurationMinutes", "emergencyRate", "highRiskRate", "complicationRate", "ponvRate", "meanAldrete", "meanPainScore", "mappingCoverage", "fieldCompleteness"] },
    value: nullable({ type: "number" }),
    numerator: nullable({ type: "number" }),
    denominator: nullable({ type: "number" }),
    unit: { type: "string", enum: ["count", "percent", "years", "days", "kg/m2", "minutes", "score"] },
    suppressed: { type: "boolean" },
  }, ["id", "value", "suppressed"]),
  ResearchDistributionBucket: object({
    key: { type: "string" },
    label: { type: "string" },
    labelEn: { type: "string" },
    labelBg: nullable({ type: "string" }),
    count: nullable({ type: "integer", minimum: 0 }),
    percent: nullable({ type: "number" }),
    suppressed: { type: "boolean" },
  }, ["key", "label", "count", "percent", "suppressed"]),
  ResearchDistribution: object({
    id: { type: "string", enum: ["sex", "asa", "status", "clinicalMode", "procedure", "diagnosis", "technique", "airway", "disposition", "complication"] },
    buckets: arrayOf("ResearchDistributionBucket"),
  }, ["id", "buckets"]),
  ResearchCaseSummary: object({
    id: { type: "string" },
    researchId: { type: "string" },
    status: { type: "string", enum: ["DRAFT", "IN_PROGRESS", "AWAITING_REVIEW", "COMPLETE"] },
    clinicalMode: { type: "string", enum: ["ADULT", "PEDIATRIC"] },
    clinicalRulesVersion: nullable({ type: "string" }),
    period: nullable({ type: "string", pattern: "^[0-9]{4}-[0-9]{2}$" }),
    ageValue: nullable({ type: "number" }),
    ageUnit: nullable({ type: "string", enum: ["DAYS", "MONTHS", "YEARS"] }),
    ageApproxDays: nullable({ type: "number" }),
    ageYears: nullable({ type: "number" }),
    sex: nullable({ type: "string" }),
    asa: nullable({ type: "string" }),
    diagnosis: nullable({ type: "string" }),
    diagnosisCode: nullable({ type: "string" }),
    diagnosisLabelEn: nullable({ type: "string" }),
    diagnosisLabelBg: nullable({ type: "string" }),
    procedure: nullable({ type: "string" }),
    procedureCode: nullable({ type: "string" }),
    procedureLabelEn: nullable({ type: "string" }),
    procedureLabelBg: nullable({ type: "string" }),
    durationMinutes: nullable({ type: "number" }),
    technique: { type: "array", items: { type: "string" } },
    disposition: nullable({ type: "string" }),
    complications: { type: "integer", minimum: 0 },
    completeness: { type: "number", minimum: 0, maximum: 100 },
  }, ["id", "researchId", "status", "clinicalMode", "clinicalRulesVersion", "period", "ageValue", "ageUnit", "ageApproxDays", "ageYears", "sex", "asa", "diagnosis", "diagnosisCode", "procedure", "procedureCode", "durationMinutes", "technique", "disposition", "complications", "completeness"]),
  ResearchQueryResponse: object({
    apiVersion: { type: "integer", const: 1 },
    source: { type: "string", enum: ["LOSPOR", "OMOP"] },
    cohort: ref("ResearchCohort"),
    matchingCases: nullable({ type: "integer", minimum: 0 }),
    matchingCaseCount: ref("ResearchCountDisclosure"),
    metrics: arrayOf("ResearchMetric"),
    distributions: arrayOf("ResearchDistribution"),
    cases: arrayOf("ResearchCaseSummary"),
    pagination: nullable(ref("ResearchPagination")),
    generatedAt: { type: "string", format: "date-time" },
  }, ["apiVersion", "source", "cohort", "matchingCases", "matchingCaseCount", "metrics", "distributions", "cases", "pagination", "generatedAt"]),
  ResearchCaseQueryResponse: object({
    apiVersion: { type: "integer", const: 1 },
    source: { type: "string", enum: ["LOSPOR", "OMOP"] },
    cohort: ref("ResearchCohort"),
    matchingCases: { type: "integer", minimum: 0 },
    cases: arrayOf("ResearchCaseSummary"),
    pagination: ref("ResearchPagination"),
    generatedAt: { type: "string", format: "date-time" },
  }, ["apiVersion", "source", "cohort", "matchingCases", "cases", "pagination", "generatedAt"]),
  ResearchCaseDetail: {
    allOf: [
      ref("ResearchCaseSummary"),
      {
        type: "object",
        properties: {
          demographics: { type: "object", additionalProperties: true },
          diagnoses: { type: "array", items: { type: "object", additionalProperties: true } },
          comorbidities: { type: "array", items: { type: "object", additionalProperties: true } },
          procedures: { type: "array", items: { type: "object", additionalProperties: true } },
          medications: { type: "array", items: { type: "object", additionalProperties: true } },
          labs: { type: "array", items: { type: "object", additionalProperties: true } },
          intraoperative: { type: "object", additionalProperties: true },
          postoperative: { type: "object", additionalProperties: true },
          timeline: { type: "array", items: { type: "object", additionalProperties: true } },
          quality: { type: "object", additionalProperties: true },
        },
        additionalProperties: false,
      },
    ],
  },
  ResearchComparisonRequest: object({
    left: ref("ResearchCohort"),
    right: ref("ResearchCohort"),
    metrics: { type: "array", items: { type: "string", enum: ["caseCount", "pediatricRate", "meanAgeYears", "meanAgeDays", "meanBmi", "meanDurationMinutes", "emergencyRate", "highRiskRate", "complicationRate", "ponvRate", "meanAldrete", "meanPainScore", "mappingCoverage", "fieldCompleteness"] } },
  }, ["left", "right"]),
  ResearchComparisonMetric: object({
    id: { type: "string" },
    left: ref("ResearchMetric"),
    right: ref("ResearchMetric"),
    absoluteDifference: nullable({ type: "number" }),
    relativeDifferencePercent: nullable({ type: "number" }),
  }, ["id", "left", "right", "absoluteDifference", "relativeDifferencePercent"]),
  ResearchComparisonResponse: object({
    leftCount: nullable({ type: "integer", minimum: 0 }),
    rightCount: nullable({ type: "integer", minimum: 0 }),
    leftCaseCount: ref("ResearchCountDisclosure"),
    rightCaseCount: ref("ResearchCountDisclosure"),
    metrics: arrayOf("ResearchComparisonMetric"),
    generatedAt: { type: "string", format: "date-time" },
  }, ["leftCount", "rightCount", "leftCaseCount", "rightCaseCount", "metrics", "generatedAt"]),
  ResearchBenchmarkPoint: object({
    period: { type: "string" }, institutionId: { type: "string" }, institutionLabel: { type: "string" },
    value: nullable({ type: "number" }), caseCount: nullable({ type: "integer", minimum: 0 }),
    caseCountDisclosure: ref("ResearchCountDisclosure"), previousValue: nullable({ type: "number" }),
    absoluteChange: nullable({ type: "number" }), relativeChangePercent: nullable({ type: "number" }), suppressed: { type: "boolean" },
  }, ["period", "value", "caseCount", "caseCountDisclosure", "previousValue", "absoluteChange", "relativeChangePercent", "suppressed"]),
  ResearchBenchmarkRequest: object({
    cohort: ref("ResearchCohort"),
    interval: { type: "string", enum: ["month", "quarter", "year"] },
    metric: { type: "string", enum: ["caseCount", "pediatricRate", "meanAgeYears", "meanAgeDays", "meanBmi", "meanDurationMinutes", "emergencyRate", "highRiskRate", "complicationRate", "ponvRate", "meanAldrete", "meanPainScore", "mappingCoverage", "fieldCompleteness"] },
    institutionIds: { type: "array", items: { type: "string" } },
    compareWithPreviousPeriod: { type: "boolean" },
  }, ["cohort", "interval", "metric"]),
  ResearchBenchmarkResponse: object({
    metric: { type: "string" },
    interval: { type: "string", enum: ["month", "quarter", "year"] },
    points: arrayOf("ResearchBenchmarkPoint"),
    generatedAt: { type: "string", format: "date-time" },
  }, ["metric", "interval", "points", "generatedAt"]),
  ResearchQualityField: object({
    section: { type: "string" }, field: { type: "string" },
    present: nullable({ type: "integer", minimum: 0 }), absent: nullable({ type: "integer", minimum: 0 }),
    notApplicable: nullable({ type: "integer", minimum: 0 }), completeness: nullable({ type: "number" }),
    suppressed: { type: "boolean" },
  }, ["section", "field", "present", "absent", "notApplicable", "completeness", "suppressed"]),
  ResearchQualityMapping: object({
    domain: { type: "string" }, mapped: nullable({ type: "integer", minimum: 0 }),
    sourceOnly: nullable({ type: "integer", minimum: 0 }), unmapped: nullable({ type: "integer", minimum: 0 }),
    coverage: nullable({ type: "number" }), suppressed: { type: "boolean" },
  }, ["domain", "mapped", "sourceOnly", "unmapped", "coverage", "suppressed"]),
  ResearchQualityResponse: object({
    totalCases: nullable({ type: "integer", minimum: 0 }),
    totalCaseCount: ref("ResearchCountDisclosure"),
    finalizedCases: nullable({ type: "integer", minimum: 0 }),
    snapshotCoverage: nullable({ type: "number" }),
    relationalDriftCases: nullable({ type: "integer", minimum: 0 }),
    impossibleTimelineCases: nullable({ type: "integer", minimum: 0 }),
    suppressed: { type: "boolean" },
    fields: arrayOf("ResearchQualityField"), mappings: arrayOf("ResearchQualityMapping"),
    generatedAt: { type: "string", format: "date-time" },
  }, ["totalCases", "totalCaseCount", "finalizedCases", "snapshotCoverage", "relationalDriftCases", "impossibleTimelineCases", "suppressed", "fields", "mappings", "generatedAt"]),
  ResearchPermissionSet: object({
    query: { type: "boolean" }, inspectCases: { type: "boolean" }, compare: { type: "boolean" },
    benchmark: { type: "boolean" }, savePrivateCohorts: { type: "boolean" },
    shareInstitutionCohorts: { type: "boolean" }, export: { type: "boolean" },
    exportOmop: { type: "boolean" }, manageAccess: { type: "boolean" },
  }, ["query", "inspectCases", "compare", "benchmark", "savePrivateCohorts", "shareInstitutionCohorts", "export", "exportOmop", "manageAccess"]),
  ResearchScope: object({
    kind: { type: "string", enum: ["OWN", "INSTITUTION", "GRANT", "ALL"] },
    institutionIds: { type: "array", items: { type: "string" } },
    institutionLabels: { type: "array", items: { type: "string" } },
  }, ["kind", "institutionIds", "institutionLabels"]),
  ResearchActionScopes: object({
    query: ref("ResearchScope"), inspectCases: ref("ResearchScope"),
    export: ref("ResearchScope"), exportOmop: ref("ResearchScope"),
  }, ["query", "inspectCases", "export", "exportOmop"]),
  ResearchMetadata: object({
    apiVersion: { type: "integer", const: 1 }, source: { type: "string", enum: ["LOSPOR", "OMOP"] },
    sourceLabel: { type: "string" }, sourceVersion: { type: "string" },
    generatedAt: { type: "string", format: "date-time" },
    dataFreshnessAt: nullable({ type: "string", format: "date-time" }),
    scope: ref("ResearchScope"), scopes: ref("ResearchActionScopes"),
    permissions: ref("ResearchPermissionSet"), suppressionThreshold: { type: "integer", minimum: 1 },
    defaultCohort: ref("ResearchCohort"),
    supportedMetrics: { type: "array", items: { type: "string" } },
    supportedDistributions: { type: "array", items: { type: "string" } },
    supportedExports: { type: "array", items: { type: "string", enum: ["csv", "json", "omop-csv", "omop-json"] } },
  }, ["apiVersion", "source", "sourceLabel", "sourceVersion", "generatedAt", "dataFreshnessAt", "scope", "scopes", "permissions", "suppressionThreshold", "defaultCohort", "supportedMetrics", "supportedDistributions", "supportedExports"]),
  SavedResearchCohort: object({
    id: { type: "string" }, name: { type: "string" }, description: nullable({ type: "string" }),
    visibility: { type: "string", enum: ["PRIVATE", "INSTITUTION"] }, definition: ref("ResearchCohort"),
    ownerId: { type: "string" }, institutionId: nullable({ type: "string" }),
    createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
    lastRunAt: nullable({ type: "string", format: "date-time" }),
  }, ["id", "name", "description", "visibility", "definition", "ownerId", "institutionId", "createdAt", "updatedAt", "lastRunAt"]),
  ResearchExportRecord: object({
    id: { type: "string" }, name: { type: "string" },
    format: { type: "string", enum: ["csv", "json", "omop-csv", "omop-json"] },
    status: { type: "string", enum: ["PENDING", "RUNNING", "COMPLETE", "FAILED"] },
    definition: ref("ResearchCohort"), rowCount: nullable({ type: "integer", minimum: 0 }),
    checksum: nullable({ type: "string" }), error: nullable({ type: "string" }), filename: nullable({ type: "string" }),
    contentType: nullable({ type: "string" }), byteSize: nullable({ type: "integer", minimum: 0 }),
    asOf: nullable({ type: "string", format: "date-time" }),
    definitionHash: nullable({ type: "string" }), snapshotHash: nullable({ type: "string" }),
    matchingCases: nullable({ type: "integer", minimum: 0 }),
    sourceCommit: nullable({ type: "string" }),
    sourceVersion: nullable({ type: "string" }), generatedAt: nullable({ type: "string", format: "date-time" }),
    revisionManifestVersion: { type: "integer", minimum: 1 },
    expiresAt: nullable({ type: "string", format: "date-time" }),
    artifactAvailable: { type: "boolean" },
    legacy: { type: "boolean" }, createdAt: { type: "string", format: "date-time" },
    completedAt: nullable({ type: "string", format: "date-time" }),
  }, ["id", "name", "format", "status", "definition", "rowCount", "checksum", "error", "filename", "asOf", "definitionHash", "snapshotHash", "matchingCases", "sourceCommit", "contentType", "byteSize", "sourceVersion", "generatedAt", "revisionManifestVersion", "expiresAt", "artifactAvailable", "legacy", "createdAt", "completedAt"]),
  SavedResearchCohortRequest: object({
    name: { type: "string", minLength: 1, maxLength: 120 },
    description: nullable({ type: "string", maxLength: 500 }),
    visibility: { type: "string", enum: ["PRIVATE", "INSTITUTION"] },
    institutionId: nullable({ type: "string" }),
    definition: ref("ResearchCohort"),
  }, ["name", "definition"]),
  SavedResearchCohortPatch: object({
    name: { type: "string", minLength: 1, maxLength: 120 },
    description: nullable({ type: "string", maxLength: 500 }),
    visibility: { type: "string", enum: ["PRIVATE", "INSTITUTION"] },
    institutionId: nullable({ type: "string" }),
    definition: ref("ResearchCohort"),
    expectedUpdatedAt: { type: "string", format: "date-time" },
  }),
  ResearchExportRequest: object({
    name: { type: "string", minLength: 1, maxLength: 120 },
    format: { type: "string", enum: ["csv", "json", "omop-csv", "omop-json"] },
    definition: { ...ref("ResearchCohort"), description: "Must select finalized cases only (statuses = [COMPLETE])." },
  }, ["name", "format", "definition"]),
  ResearchGrantRequest: object({
    userId: { type: "string" },
    institutionId: nullable({ type: "string" }),
    allInstitutions: { type: "boolean" },
    canQuery: { type: "boolean" },
    canInspectCases: { type: "boolean" },
    canExport: { type: "boolean" },
    canExportOmop: { type: "boolean" },
    canShareCohorts: { type: "boolean" },
    expiresAt: { type: "string", format: "date-time" },
  }, ["userId"]),
  ResearchGrantPatch: object({
    canQuery: { type: "boolean" },
    canInspectCases: { type: "boolean" },
    canExport: { type: "boolean" },
    canExportOmop: { type: "boolean" },
    canShareCohorts: { type: "boolean" },
    expiresAt: { type: "string", format: "date-time" },
    revoked: { type: "boolean" },
  }),
  ResearchGrant: {
    type: "object",
    properties: {
      id: { type: "string" }, userId: { type: "string" }, institutionId: nullable({ type: "string" }),
      allInstitutions: { type: "boolean" }, canQuery: { type: "boolean" },
      canInspectCases: { type: "boolean" }, canExport: { type: "boolean" },
      canExportOmop: { type: "boolean" }, canShareCohorts: { type: "boolean" },
      expiresAt: { type: "string", format: "date-time" },
      revokedAt: nullable({ type: "string", format: "date-time" }),
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      user: { type: "object", additionalProperties: true },
      institution: nullable({ type: "object", additionalProperties: true }),
      grantedBy: { type: "object", additionalProperties: true },
    },
    required: [
      "id", "userId", "institutionId", "allInstitutions", "canQuery", "canInspectCases",
      "canExport", "canExportOmop", "canShareCohorts", "expiresAt", "revokedAt", "createdAt", "updatedAt",
    ],
    additionalProperties: true,
  },
  ResearchSelfAuthorizationStatus: object({
    eligible: { type: "boolean" },
    activeUntil: nullable({ type: "string", format: "date-time" }),
    nextEligibleAt: { type: "string", format: "date-time" },
    permissions: object({
      query: { type: "boolean" },
      inspectCases: { type: "boolean" },
      export: { type: "boolean" },
      exportOmop: { type: "boolean" },
      shareInstitutionCohorts: { type: "boolean" },
    }, ["query", "inspectCases", "export", "exportOmop", "shareInstitutionCohorts"]),
  }, ["activeUntil", "nextEligibleAt", "permissions"]),
  ResearchExportCleanup: object({
    expiredArtifacts: { type: "integer", minimum: 0 },
    workingArtifacts: { type: "integer", minimum: 0 },
    failures: { type: "integer", minimum: 0 },
  }, ["expiredArtifacts", "workingArtifacts", "failures"]),
  ResearchExportWorkerResponse: object({
    processed: { type: "integer", minimum: 0 },
    failed: { type: "integer", minimum: 0 },
    ids: { type: "array", items: { type: "string" } },
    cleanup: ref("ResearchExportCleanup"),
  }, ["processed", "failed", "ids", "cleanup"]),
  JsonObject: { type: "object", additionalProperties: true },
}

const body = (schema, contentType = "application/json") => ({
  required: true,
  content: { [contentType]: { schema } },
})
const response = (description, schema, contentType = "application/json", headers) => ({
  description,
  ...(schema ? { content: { [contentType]: { schema } } } : {}),
  ...(headers ? { headers } : {}),
})
const query = (name, schema, required = false, description) => ({
  name, in: "query", required, schema, ...(description ? { description } : {}),
})
const pathParameter = name => ({
  name, in: "path", required: true, schema: { type: "string" },
})
const header = (name, schema, required = false, description) => ({
  name, in: "header", required, schema, ...(description ? { description } : {}),
})

const contracts = new Map()
function add(method, path, summary, options = {}) {
  const key = `${method} ${path}`
  if (contracts.has(key)) throw new Error(`Duplicate OpenAPI contract: ${key}`)
  const tag = options.tag ?? path.split("/").filter(Boolean)[1] ?? "health"
  const errors = options.errors ?? [400, 401, 403, 404, 409, 422, 429, 500]
  const responses = options.tombstone
    ? { 410: response("Compatibility endpoint removed", ref("ApiError")) }
    : {
        [options.status ?? 200]: options.response ??
          response("Successful response", options.result ?? ref("JsonObject")),
        ...(options.additionalResponses ?? {}),
      }
  for (const status of errors) {
    if (!responses[status]) responses[status] = response(
      status === 400 ? "Invalid request"
        : status === 401 ? "Authentication required"
        : status === 403 ? "Insufficient access"
        : status === 404 ? "Resource not found"
        : status === 409 ? "Revision, ownership, or uniqueness conflict"
        : status === 422 ? "Request is valid but cannot be completed"
        : status === 429 ? "Rate limit exceeded"
        : "Server error",
      status === 422 && options.exportLimit ? ref("ExportLimitError") : ref("ApiError"),
    )
  }
  contracts.set(key, {
    summary,
    tags: [tag],
    "x-lospor-explicit-contract": true,
    "x-lospor-stability": options.stability ?? "stable",
    ...(options.tombstone ? { "x-lospor-tombstone": true } : {}),
    ...(options.public ? { security: [] } : {}),
    ...(options.parameters?.length ? { parameters: options.parameters } : {}),
    ...(options.requestBody ? { requestBody: options.requestBody } : {}),
    responses,
  })
}

const id = pathParameter("id")
const skipTake = [
  query("skip", { type: "integer", minimum: 0, default: 0 }),
  query("take", { type: "integer", minimum: 1, maximum: 200, default: 50 }),
]
const revisions = ["preop", "intraop", "postop"].map(section =>
  header(`x-lospor-${section}-revision`, { type: "integer", minimum: 0 }, false, "Last acknowledged section revision"))

add("GET", "/health/live", "Check whether the API process is alive", { public: true, result: ref("Message"), errors: [500], tag: "health" })
add("GET", "/health/ready", "Check API, database and exact legal-document readiness", { public: true, result: ref("ReadinessResponse"), errors: [500, 503], tag: "health" })
add("GET", "/v1/capabilities", "Read API synchronization capabilities", { public: true, result: ref("Capabilities") })
add("GET", "/v1/institutions", "List selectable institutions", { public: true, result: arrayOf("Institution") })

add("GET", "/v1/auth/check-pending", "Compatibility response: account approval queues are removed", { public: true, result: ref("JsonObject"), stability: "deprecated" })
add("GET", "/v1/auth/session", "Read the current browser session", { public: true, result: ref("SessionResponse") })
add("POST", "/v1/auth/session", "Create a browser session", {
  public: true,
  requestBody: body(ref("LoginRequest")),
  result: ref("SessionResponse"),
  errors: [400, 401, 429, 503],
  additionalResponses: {
    202: response("Administrator MFA continuation required", ref("MfaChallengeResponse")),
  },
})
add("DELETE", "/v1/auth/session", "End the current browser session", { result: ref("Message"), errors: [401, 503] })
add("POST", "/v1/auth/logout", "Revoke the current bearer or browser session", { result: ref("Message"), errors: [401, 503] })
add("POST", "/v1/auth/token", "Create a mobile bearer token", {
  public: true,
  requestBody: body(ref("LoginRequest")),
  result: ref("TokenResponse"),
  errors: [400, 401, 429, 503],
  additionalResponses: {
    202: response("Administrator MFA continuation required", ref("MfaChallengeResponse")),
  },
})
add("POST", "/v1/auth/mfa/login", "Complete a one-use administrator TOTP or recovery-code login challenge", {
  public: true,
  requestBody: body(ref("MfaLoginContinuationRequest")),
  result: ref("MfaLoginContinuationResponse"),
  errors: [400, 401, 409, 429, 503],
})
add("POST", "/v1/auth/register", "Public-only registration for an institution-bound member pending email verification", { public: true, requestBody: body(ref("RegisterRequest")), status: 201, result: ref("RegisterResponse"), errors: [400, 404, 409, 422, 503] })
add("GET", "/v1/auth/verify-email", "Public-only email verification and account activation", { public: true, parameters: [query("token", { type: "string" }, true)], result: ref("Message"), errors: [404, 503] })
add("POST", "/v1/auth/verify-email/resend", "Public-only email verification resend", { public: true, requestBody: body(ref("EmailRequest")), result: ref("Message"), errors: [404, 503] })
add("POST", "/v1/auth/password-reset/request", "Public-only email password reset request without disclosing account or delivery state", { public: true, status: 202, requestBody: body(ref("EmailRequest")), result: ref("Message"), errors: [404, 503] })
add("POST", "/v1/auth/password-reset/confirm", "Public-only claim of a one-time email reset token and password change", { public: true, requestBody: body(ref("PasswordResetConfirmRequest")), result: ref("Message"), errors: [400, 404, 409, 503] })

add("GET", "/v1/legal/documents", "Read the exact active Terms and Privacy content for one locale", {
  public: true,
  parameters: [query("locale", { type: "string", enum: ["bg", "en"] }, true)],
  result: ref("LegalDocumentsResponse"),
  errors: [400, 503],
  tag: "legal",
})

add("GET", "/v1/cases", "List accessible cases", { parameters: skipTake, result: ref("CaseListResponse") })
add("POST", "/v1/cases", "Create an idempotent clinical case draft", {
  requestBody: body(ref("CaseCreateRequest")),
  parameters: [header("x-idempotency-key", { type: "string" }, false, "Stable client draft identity")],
  status: 201,
  result: ref("CaseMutationResponse"),
})
add("GET", "/v1/cases/demo", "Create or read the demonstration case", { result: ref("CaseDetail") })
add("GET", "/v1/cases/{id}", "Read a case", { parameters: [id], result: ref("CaseDetail") })
add("PATCH", "/v1/cases/{id}", "Save one or more case sections", {
  parameters: [id, ...revisions, header("x-lospor-force-update", { type: "boolean" })],
  requestBody: body(ref("CasePatchRequest")),
  result: ref("CaseDetail"),
})
add("DELETE", "/v1/cases/{id}", "Delete a case", { parameters: [id], result: ref("Message") })
add("GET", "/v1/cases/{id}/version", "Read current section revisions", { parameters: [id], result: ref("CaseVersion") })
add("GET", "/v1/cases/{id}/calculations", "List accepted pediatric calculations", { parameters: [id], result: arrayOf("PediatricCalculation") })
add("POST", "/v1/cases/{id}/calculations", "Recompute and accept a pediatric calculation", {
  parameters: [id],
  requestBody: body(ref("PediatricCalculationRequest")),
  status: 201,
  result: ref("PediatricCalculation"),
  errors: [400, 401, 403, 404, 409, 422, 500],
})
add("POST", "/v1/cases/{id}/finalize", "Finalize a case and create its immutable snapshot", { parameters: [id], result: ref("CaseDetail") })
add("POST", "/v1/cases/{id}/unfinalize", "Resume editing a finalized case", { parameters: [id], result: ref("CaseDetail") })

add("POST", "/v1/cases/{id}/lock", "Acquire a case editing lease", { parameters: [id], requestBody: body(ref("LockRequest")), result: ref("LockResponse") })
add("PATCH", "/v1/cases/{id}/lock", "Refresh or reclaim a case editing lease", { parameters: [id], requestBody: body(ref("LockRequest")), result: ref("LockResponse") })
add("DELETE", "/v1/cases/{id}/lock", "Release or force-release a case editing lease", { parameters: [id], requestBody: body(ref("LockReleaseRequest")), result: ref("ReleaseResponse") })

add("POST", "/v1/cases/{id}/events", "Append an idempotent intraoperative event", {
  parameters: [id, header("x-lospor-intraop-revision", { type: "integer" })],
  requestBody: body(ref("Event")),
  status: 201,
  result: ref("EventMutationResponse"),
})
add("PUT", "/v1/cases/{id}/events", "Replace and reconcile the complete event log", {
  parameters: [id, header("x-lospor-intraop-revision", { type: "integer" })],
  requestBody: body(arrayOf("Event")),
  result: ref("EventMutationResponse"),
})
add("PUT", "/v1/cases/{id}/events/{eventId}", "Update an intraoperative event", {
  parameters: [id, pathParameter("eventId"), header("x-lospor-intraop-revision", { type: "integer" })],
  requestBody: body(ref("Event")),
  result: ref("EventMutationResponse"),
})
add("DELETE", "/v1/cases/{id}/events/{eventId}", "Delete an intraoperative event", {
  parameters: [id, pathParameter("eventId"), header("x-lospor-intraop-revision", { type: "integer" })],
  result: ref("EventMutationResponse"),
})

add("POST", "/v1/cases/{id}/transfer", "Offer a case transfer", { parameters: [id], requestBody: body(ref("TransferRequest")), status: 201, result: ref("Transfer") })
add("PATCH", "/v1/cases/{id}/transfer", "Accept or decline a case transfer", { parameters: [id], requestBody: body(ref("TransferDecisionRequest")), result: ref("Transfer") })
add("GET", "/v1/cases/{id}/transfers", "Read a case handover history", { parameters: [id], result: arrayOf("Transfer") })
add("GET", "/v1/cases/transfers/pending", "List pending case transfers", { parameters: [query("direction", { type: "string", enum: ["incoming", "outgoing"], default: "incoming" })], result: arrayOf("Transfer") })
add("GET", "/v1/users/colleagues", "List colleagues eligible for transfer", { result: arrayOf("Colleague") })

add("POST", "/v1/cases/{id}/ai/advise", "Generate case-specific AI advice", { parameters: [id], requestBody: body(ref("JsonObject")), result: ref("JsonObject") })
add("POST", "/v1/ai/advise", "Generate AI advice from supplied structured data", { requestBody: body(ref("JsonObject")), result: ref("JsonObject") })
add("POST", "/v1/cases/{id}/ai/read-labs", "Extract laboratory values from an uploaded image", { parameters: [id], requestBody: body(ref("JsonObject")), result: arrayOf("JsonObject") })
add("POST", "/v1/cases/{id}/vitals-scan", "Extract preoperative vitals from an image", { parameters: [id], requestBody: body(ref("JsonObject")), result: ref("JsonObject") })

add("POST", "/v1/cases/{id}/print-token", "Create a short-lived print token", { parameters: [id], result: ref("JsonObject") })
add("GET", "/v1/cases/{id}/print-data", "Read printable case data", { parameters: [id, query("print_token", { type: "string" })], result: ref("CaseDetail") })
add("GET", "/v1/cases/{id}/pdf", "Download a case PDF", {
  parameters: [id, query("print_token", { type: "string" }), query("lang", { type: "string", enum: ["en", "bg"] })],
  response: response("PDF document", { type: "string", format: "binary" }, "application/pdf"),
})

add("GET", "/v1/search/icd10", "Search ICD-10 diagnoses", { parameters: [query("q", { type: "string" }, true), query("locale", { type: "string", enum: ["en", "bg"], default: "en" })], result: arrayOf("SearchResult") })
add("GET", "/v1/search/procedures", "Search procedure terminology", { parameters: [query("q", { type: "string" }, true)], result: arrayOf("SearchResult") })
add("GET", "/v1/search/drugs", "Search medication terminology", { parameters: [query("q", { type: "string" }, true)], result: arrayOf("SearchResult") })
add("GET", "/v1/library/{category}", "Read an option-library category", { parameters: [pathParameter("category")], result: arrayOf("LibraryOption") })
add("GET", "/v1/clinical/pediatric/rules", "Read pediatric capabilities, reviewed rules, and unavailable calculators", { result: ref("JsonObject"), tag: "clinical" })
add("GET", "/v1/clinical/rules/runtime", "Read the effective mode-specific personal, institution, or platform ruleset", { parameters: [query("mode", { type: "string", enum: ["ADULT", "PEDIATRIC"] })], result: ref("JsonObject"), errors: [400, 401], tag: "clinical" })
add("GET", "/v1/clinical/rules/workbench", "Read mode-specific rulesets in the caller's active management scope", { parameters: [query("mode", { type: "string", enum: ["ADULT", "PEDIATRIC"] }), query("scope", { type: "string", enum: ["PLATFORM", "INSTITUTION", "USER"] })], result: ref("JsonObject"), errors: [400, 401, 403, 500], tag: "clinical" })
add("POST", "/v1/clinical/rules/workbench", "Copy, edit, publish, select, or clear a clinical ruleset", { requestBody: body(ref("JsonObject")), result: ref("JsonObject"), errors: [400, 401, 403, 404, 409, 500], tag: "clinical" })

add("GET", "/v1/user", "Read the current account", { result: ref("AccountResponse") })
add("PATCH", "/v1/user", "Update account and clinical preferences", { requestBody: body(ref("JsonObject")), result: ref("AccountPatchResponse") })
add("POST", "/v1/user/change-password", "Change the current password and revoke every session", { requestBody: body(ref("PasswordChangeRequest")), result: ref("PasswordChangeResponse"), errors: [400, 401, 409] })
add("GET", "/v1/user/sessions", "List active sessions for the current account", { result: ref("AuthSessionList") })
add("DELETE", "/v1/user/sessions", "Revoke every other active session", { result: ref("SessionRevocationResponse") })
add("DELETE", "/v1/user/sessions/{id}", "Revoke one other active session", { parameters: [id], result: ref("Message"), errors: [401, 404, 409] })
add("GET", "/v1/user/legal-acceptances", "List exact legal acceptance evidence for the current account", { result: ref("LegalAcceptancesGetResponse"), tag: "legal" })
add("POST", "/v1/user/legal-acceptances", "Accept the exact active Terms and Privacy documents", { requestBody: body(ref("LegalAcceptancesRequest")), result: ref("LegalAcceptancesMutationResponse"), errors: [400, 401, 422, 503], tag: "legal" })
add("PATCH", "/v1/user/accept-terms", "Compatibility alias for exact Terms and Privacy acceptance", { requestBody: body(ref("LegalAcceptancesRequest")), result: ref("LegalAcceptancesMutationResponse"), stability: "deprecated", tag: "legal" })
add("POST", "/v1/user/delete", "Soft-delete the current account", { requestBody: body(ref("JsonObject")), result: ref("Message") })
add("GET", "/v1/user/export", "Download the complete personal data archive", { response: response("ZIP archive", { type: "string", format: "binary" }, "application/zip") })
add("GET", "/v1/locale", "Read the validated installation default locale without changing the account", { public: true, result: ref("LocaleResponse") })
add("POST", "/v1/locale", "Set the pre-auth browser/device locale without changing the account", { public: true, requestBody: body(object({ locale: { type: "string", enum: ["bg", "en"] } }, ["locale"])), result: ref("LocaleResponse") })

add("GET", "/v1/custom-terms", "Search institution custom terms", { parameters: [query("q", { type: "string" }), query("type", { type: "string" })], result: arrayOf("JsonObject") })
add("POST", "/v1/custom-terms", "Create an institution custom term", { requestBody: body(object({ term: { type: "string" }, termType: { type: "string" } }, ["term", "termType"])), status: 201, result: ref("JsonObject") })
// Choosing an institution at registration is self-service; moving afterwards
// needs approval, so it goes through a request rather than PATCH /v1/user.
add("GET", "/v1/user/institution-request", "Read the current institution-change request", { result: ref("InstitutionChangeRequest") })
add("POST", "/v1/user/institution-request", "Request a move to another institution", { status: 201, requestBody: body(object({ institutionId: { type: "string" } }, ["institutionId"])), result: ref("InstitutionChangeRequest") })
add("GET", "/v1/role-request", "Read the current role-elevation request", { result: ref("RoleRequest") })
add("POST", "/v1/role-request", "Request department-head access", { status: 201, result: ref("RoleRequest") })

add("GET", "/v1/export/dictionary", "Download the LOSPOR data dictionary", { result: ref("JsonObject") })
add("GET", "/v1/export/omop", "Download an OMOP CDM export", {
  parameters: [
    query("caseId", { type: "string" }),
    query("format", { type: "string", enum: ["json", "csv"], default: "json" }),
    query("status", { type: "string" }),
    query("force", { type: "boolean", default: false }),
  ],
  response: {
    description: "Complete OMOP JSON or CSV export",
    content: {
      "application/json": { schema: ref("JsonObject") },
      "text/csv": { schema: { type: "string" } },
    },
  },
  exportLimit: true,
})

add("GET", "/v1/research/metadata", "Read research capabilities, action scopes, and permissions", { result: ref("ResearchMetadata"), errors: [401, 403, 500], tag: "research" })
add("POST", "/v1/research/query", "Run an aggregate-only structured research cohort query", { requestBody: body(ref("ResearchQueryRequest")), result: ref("ResearchQueryResponse"), errors: [400, 401, 403, 500], tag: "research" })
add("POST", "/v1/research/cases/query", "List pseudonymous case rows inside the case-inspection scope", { requestBody: body(ref("ResearchQueryRequest")), result: ref("ResearchCaseQueryResponse"), errors: [400, 401, 403, 500], tag: "research" })
add("POST", "/v1/research/compare", "Compare two research cohorts with disclosure control", { requestBody: body(ref("ResearchComparisonRequest")), result: ref("ResearchComparisonResponse"), errors: [400, 401, 403, 500], tag: "research" })
add("POST", "/v1/research/benchmarks", "Calculate disclosure-controlled cohort trends and benchmarks", { requestBody: body(ref("ResearchBenchmarkRequest")), result: ref("ResearchBenchmarkResponse"), errors: [400, 401, 403, 500], tag: "research" })
add("GET", "/v1/research/quality", "Read disclosure-controlled research data-quality indicators", { result: ref("ResearchQualityResponse"), errors: [401, 403, 500], tag: "research" })
add("GET", "/v1/research/cases/{id}", "Read a safe pseudonymous research case", { parameters: [id], result: ref("ResearchCaseDetail"), errors: [401, 403, 404, 500], tag: "research" })
add("GET", "/v1/research/cohorts", "List visible saved research cohorts", { result: arrayOf("SavedResearchCohort"), errors: [401, 403, 500], tag: "research" })
add("POST", "/v1/research/cohorts", "Save a research cohort", { requestBody: body(ref("SavedResearchCohortRequest")), status: 201, result: ref("SavedResearchCohort"), errors: [400, 401, 403, 500], tag: "research" })
add("GET", "/v1/research/cohorts/{id}", "Read a saved research cohort", { parameters: [id], result: ref("SavedResearchCohort"), errors: [401, 403, 404, 500], tag: "research" })
add("PATCH", "/v1/research/cohorts/{id}", "Update an owned saved research cohort", { parameters: [id], requestBody: body(ref("SavedResearchCohortPatch")), result: ref("SavedResearchCohort"), errors: [400, 401, 403, 404, 409, 500], tag: "research" })
add("DELETE", "/v1/research/cohorts/{id}", "Delete an owned saved research cohort", { parameters: [id], result: ref("Message"), errors: [401, 403, 404, 500], tag: "research" })
add("GET", "/v1/research/exports", "List immutable research export history", { result: arrayOf("ResearchExportRecord"), errors: [401, 403, 500], tag: "research" })
add("POST", "/v1/research/exports", "Queue an immutable finalized-case research export", { requestBody: body(ref("ResearchExportRequest")), status: 202, result: ref("ResearchExportRecord"), errors: [400, 401, 403, 422, 500], tag: "research" })
add("GET", "/v1/research/exports/{id}", "Read immutable research export status", { parameters: [id], result: ref("ResearchExportRecord"), errors: [401, 403, 404, 500], tag: "research" })
add("GET", "/v1/research/exports/{id}/download", "Stream a completed immutable research export artifact", { parameters: [id], response: response("Research export file", { type: "string", format: "binary" }, "application/octet-stream", { "Content-Disposition": { schema: { type: "string" } }, "Content-Length": { schema: { type: "integer", minimum: 0 } }, "X-LOSPOR-Export-Complete": { schema: { type: "boolean" } }, "X-LOSPOR-Export-Rows": { schema: { type: "integer", minimum: 0 } }, "X-LOSPOR-Export-As-Of": { schema: { type: "string", format: "date-time" } }, "X-LOSPOR-Export-Snapshot-SHA256": { schema: { type: "string" } }, "X-LOSPOR-Export-SHA256": { schema: { type: "string" } } }), errors: [401, 403, 404, 409, 410, 422, 500, 503], tag: "research" })
add("GET", "/v1/research/grants", "List research access grants", { result: arrayOf("ResearchGrant"), errors: [401, 403, 500], tag: "research" })
add("POST", "/v1/research/grants", "Create a research access grant", { requestBody: body(ref("ResearchGrantRequest")), status: 201, result: ref("ResearchGrant"), errors: [400, 401, 403, 404, 409, 422, 500], tag: "research" })
add("PATCH", "/v1/research/grants/{id}", "Update a research access grant", { parameters: [id], requestBody: body(ref("ResearchGrantPatch")), result: ref("ResearchGrant"), errors: [400, 401, 403, 404, 409, 422, 500], tag: "research" })
add("DELETE", "/v1/research/grants/{id}", "Revoke a research access grant", { parameters: [id], result: ref("Message"), errors: [401, 403, 404, 500], tag: "research" })
add("GET", "/v1/research/self-authorization", "Read aggregate-only research self-authorization availability", { result: ref("ResearchSelfAuthorizationStatus"), errors: [401, 403, 500], tag: "research" })
add("POST", "/v1/research/self-authorization", "Issue an eight-hour aggregate-only research self-authorization", { status: 201, result: ref("ResearchSelfAuthorizationStatus"), errors: [401, 403, 429, 500], tag: "research" })

add("GET", "/v1/admin/clinical-rules", "Compatibility alias for the clinical-rules workbench", { result: ref("JsonObject"), stability: "admin" })
add("POST", "/v1/admin/clinical-rules", "Compatibility alias for clinical-rules workbench actions", { requestBody: body(ref("JsonObject")), result: ref("JsonObject"), errors: [400, 401, 403, 404, 409, 500], stability: "admin" })
add("GET", "/v1/admin/users", "List recoverable users and their lifecycle state", {
  parameters: [
    query("status", { type: "string", enum: ["INVITED", "ACTIVE", "SUSPENDED", "DELETION_PENDING", "RECOVERY_REQUIRED"] }),
    query("pending", { type: "boolean" }, false, "Deprecated compatibility alias for status=INVITED"),
    query("q", { type: "string", maxLength: 100 }, false, "Case-insensitive username, contact-email, or display-name filter"),
  ],
  result: arrayOf("AdminUser"),
  stability: "admin",
})
add("PATCH", "/v1/admin/users/{id}", "Update an active user's Member or HOD role and revoke prior sessions", { parameters: [id], requestBody: body(object({ role: { type: "string", enum: ["MEMBER", "HEAD_OF_DEPT"] } }, ["role"])), result: ref("AdminAccountUpdateResponse"), errors: [400, 403, 404, 409, 422], stability: "admin" })
add("DELETE", "/v1/admin/users/{id}", "Delete a user account", { parameters: [id], result: ref("Message"), stability: "admin" })
add("POST", "/v1/admin/users/{id}/authority", "Change administrator authority or clinical/research account kind with password re-entry", {
  parameters: [id],
  requestBody: body(object({
    role: { type: "string", enum: ["MEMBER", "HEAD_OF_DEPT", "ADMIN"] },
    accountKind: { type: "string", enum: ["CLINICAL", "RESEARCH_ONLY"] },
    currentPassword: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 3, maxLength: 500 },
  }, ["currentPassword", "reason"])),
  result: ref("AdminAccountUpdateResponse"),
  errors: [400, 401, 403, 404, 409],
  stability: "admin",
})
for (const [operation, summary] of [
  ["suspend", "Suspend an account and revoke every session"],
  ["reactivate", "Reactivate a suspended account"],
  ["restore", "Restore a deletion-pending account into recovery-required state"],
]) {
  add("POST", `/v1/admin/users/{id}/${operation}`, summary, {
    parameters: [id],
    requestBody: body(object({ reason: { type: "string", minLength: 3, maxLength: 500 } }, ["reason"])),
    result: ref("Message"),
    errors: [400, 401, 403, 404, 409],
    stability: "admin",
  })
}
add("POST", "/v1/admin/users/{id}/approve", "Removed account-approval compatibility endpoint", { parameters: [id], tombstone: true, errors: [401, 403], stability: "deprecated" })
// Joining a department is what lets its head see a clinician's cases, so an
// administrator sees every request and a head of department sees only requests
// to join their own institution.
add("GET", "/v1/admin/institution-requests", "List pending institution-change requests", { result: arrayOf("InstitutionChangeRequest"), stability: "admin" })
add("POST", "/v1/admin/institution-requests/{id}", "Approve or reject an institution change", { parameters: [id], requestBody: body(object({ decision: { type: "string", enum: ["APPROVE", "REJECT"] } }, ["decision"])), result: ref("InstitutionChangeRequest"), stability: "admin" })
add("GET", "/v1/admin/role-requests", "List role-elevation requests", { result: arrayOf("RoleRequest"), stability: "admin" })
add("PATCH", "/v1/admin/role-requests/{id}", "Approve or reject a role request", { parameters: [id], requestBody: body(object({ action: { type: "string", enum: ["approve", "reject"] } }, ["action"])), result: ref("RoleRequest"), stability: "admin" })
add("GET", "/v1/admin/audit-logs", "List paged audit history and its bilingual action catalog", { parameters: [query("page", { type: "integer", minimum: 0 }), query("action", { type: "string" })], result: ref("AuditLogPage"), stability: "admin" })
add("POST", "/v1/admin/repair-relational", "Repair relational projections in batches", { parameters: [query("caseId", { type: "string" }), query("batch", { type: "integer", minimum: 1, maximum: 200 }), query("cursor", { type: "string" })], result: ref("JsonObject"), stability: "maintenance" })
add("POST", "/v1/admin/maintenance/seed-option-library", "Synchronize the canonical option catalog", { result: ref("JsonObject"), stability: "maintenance" })

add("GET", "/v1/internal/option-library-snapshot", "Read the signed option-library snapshot", {
  parameters: [header("x-snapshot-secret", { type: "string" }, true)],
  result: ref("JsonObject"),
  stability: "internal",
  tag: "internal",
})
add("GET", "/v1/internal/purge-deleted", "Purge accounts past the retention period", {
  parameters: [header("x-cron-secret", { type: "string" }), header("authorization", { type: "string" })],
  result: ref("JsonObject"),
  stability: "internal",
  tag: "internal",
})
add("GET", "/v1/internal/research-exports/process", "Process queued research exports", {
  parameters: [header("authorization", { type: "string" }, true)],
  result: ref("ResearchExportWorkerResponse"),
  errors: [401, 500, 503],
  stability: "internal",
  tag: "internal",
})
add("POST", "/v1/internal/research-exports/process", "Process queued research exports", {
  parameters: [header("authorization", { type: "string" }, true)],
  result: ref("ResearchExportWorkerResponse"),
  errors: [401, 500, 503],
  stability: "internal",
  tag: "internal",
})


export const contractEntries = [...contracts.entries()]
export const contractKeys = new Set(contracts.keys())

export function buildDocument({ includeInternal = false } = {}) {
  const paths = {}
  for (const [key, operation] of contractEntries) {
    const [method, path] = key.split(" ")
    if (!includeInternal && path.startsWith("/v1/internal/")) continue
    paths[path] ??= {}
    paths[path][method.toLowerCase()] = {
      operationId: `${method.toLowerCase()}_${path
        .replace(/^\//, "")
        .replace(/[{}]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "_")}`,
      ...operation,
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: includeInternal ? "LOSPOR API - internal inventory" : "LOSPOR API",
      version: API_RELEASE_VERSION,
      description: includeInternal
        ? "Complete server contract, including secret maintenance jobs."
        : "Complete V1 contract for LOSPOR web, native mobile, PWA, administrators, and integrations.",
    },
    servers: [
      { url: "https://api.lospor.org", description: "LOSPOR reference deployment" },
      { url: "http://localhost:3002", description: "Local development or self-hosted node" },
    ],
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        cookieAuth: { type: "apiKey", in: "cookie", name: "lospor_session" },
      },
      headers: {
        PreopRevision: { schema: { type: "integer" }, description: "Current preoperative revision" },
        IntraopRevision: { schema: { type: "integer" }, description: "Current intraoperative revision" },
        PostopRevision: { schema: { type: "integer" }, description: "Current postoperative revision" },
      },
    },
  }
}
