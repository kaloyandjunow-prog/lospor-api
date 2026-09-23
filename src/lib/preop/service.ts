import { Prisma, PreopAnswerState, PreopProfileStatus } from "@/generated/prisma/client"
import {
  A3_WEIGHT_LOSS_CONCEPT_ID,
  BUNDLED_PREOP_QUESTIONS,
  DEFAULT_ENABLED_QUESTION_KEYS,
  PREOP_CATALOG_VERSION,
  type PreopCatalogQuestion,
} from "./catalog"

type Db = Prisma.TransactionClient | PrismaClientLike
type PrismaClientLike = {
  preopQuestionDefinition: any
  preopAssessmentProfile: any
  preopCaseProfilePin: any
  preopAssessmentAnswer: any
  preopAssessmentAuditEvent: any
}

export type PreopAnswerInput = {
  stableKey: string
  state: PreopAnswerState
  optionKey?: string | null
  valueText?: string | null
  valueNumber?: number | null
  valueDate?: string | null
}

export type ProfileQuestionInput = {
  stableKey: string
  enabled: boolean
  required: boolean
  sortOrder: number
}

export type PreopProfileShape = {
  id: string
  version: number
  catalogVersion: string
  status: string
  publishedAt: Date | null
  questions: Array<{
    stableKey: string
    enabled: boolean
    required: boolean
    sortOrder: number
    labelEn: string
    labelBg: string
    answerType: string
    applicability: string[]
    allowUnknown: boolean
    allowNotApplicable: boolean
    conditionalRuleKey: string | null
    omopDomain: string | null
    omopConceptId: number | null
    omopSourceCode: string | null
    options: Array<{
      key: string
      labelEn: string
      labelBg: string
      omopConceptId: number | null
      omopVocabulary: string | null
      omopSourceCode: string | null
    }>
  }>
}

export class PreopContractError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

function json(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  return value == null ? Prisma.JsonNull : value as Prisma.InputJsonValue
}

function catalogData(item: PreopCatalogQuestion) {
  return {
    stableKey: item.stableKey,
    catalogVersion: item.catalogVersion,
    section: item.section,
    applicability: item.applicability,
    answerType: item.answerType,
    labelEn: item.labelEn,
    labelBg: item.labelBg,
    requiredDefault: item.requiredDefault,
    allowUnknown: item.allowUnknown,
    allowNotApplicable: item.allowNotApplicable,
    conditionalRuleKey: item.conditionalRuleKey ?? null,
    omopDomain: item.omopDomain ?? null,
    omopConceptId: item.omopConceptId ?? null,
    omopVocabulary: item.omopVocabulary ?? null,
    omopSourceCode: item.omopSourceCode ?? null,
  }
}

/** Provisioning is idempotent and never updates bundled clinical metadata. */
export async function provisionPreopCatalog(db: Db): Promise<void> {
  for (const item of BUNDLED_PREOP_QUESTIONS) {
    const existing = await db.preopQuestionDefinition.findUnique({ where: { stableKey: item.stableKey }, include: { options: true } })
    if (!existing) {
      await db.preopQuestionDefinition.create({
        data: {
          ...catalogData(item),
          options: { create: item.options.map((option, sortOrder) => ({ ...option, sortOrder })) },
        },
      })
      continue
    }
    const expected = catalogData(item)
    const immutableFields = [
      "catalogVersion", "section", "answerType", "labelEn", "labelBg",
      "requiredDefault", "allowUnknown", "allowNotApplicable", "conditionalRuleKey",
      "omopDomain", "omopConceptId", "omopVocabulary", "omopSourceCode",
    ] as const
    for (const field of immutableFields) {
      if (existing[field] !== expected[field]) {
        throw new PreopContractError("PREOP_CATALOG_METADATA_MISMATCH", { stableKey: item.stableKey, field })
      }
    }
    for (const option of item.options) {
      const found = existing.options.find((value: any) => value.key === option.key)
      if (!found || found.labelEn !== option.labelEn || found.labelBg !== option.labelBg
        || found.omopConceptId !== (option.omopConceptId ?? null)
        || found.omopVocabulary !== (option.omopVocabulary ?? null)
        || found.omopSourceCode !== (option.omopSourceCode ?? null)) {
        throw new PreopContractError("PREOP_CATALOG_OPTION_MISMATCH", { stableKey: item.stableKey, optionKey: option.key })
      }
    }
  }
}

function profileCreateQuestions(
  configs: ProfileQuestionInput[],
): { stableKey: string; enabled: boolean; required: boolean; sortOrder: number }[] {
  const seen = new Set<string>()
  return configs.map(config => {
    const catalog = BUNDLED_PREOP_QUESTIONS.find(item => item.stableKey === config.stableKey)
    if (!catalog) throw new PreopContractError("UNKNOWN_PREOP_QUESTION", { stableKey: config.stableKey })
    if (seen.has(config.stableKey)) throw new PreopContractError("DUPLICATE_PREOP_QUESTION", { stableKey: config.stableKey })
    seen.add(config.stableKey)
    if (!config.enabled && config.required) throw new PreopContractError("DISABLED_QUESTION_CANNOT_BE_REQUIRED", { stableKey: config.stableKey })
    if (!Number.isSafeInteger(config.sortOrder) || config.sortOrder < 0) throw new PreopContractError("INVALID_PREOP_QUESTION_ORDER", { stableKey: config.stableKey })
    return config
  })
}

export async function activePreopProfile(db: Db) {
  return db.preopAssessmentProfile.findFirst({
    where: { status: PreopProfileStatus.PUBLISHED },
    orderBy: { version: "desc" },
    include: { questions: { include: { question: { include: { options: { orderBy: { sortOrder: "asc" } } } } }, orderBy: { sortOrder: "asc" } } },
  })
}

export async function ensureInitialPreopProfile(db: Db, actorId: string): Promise<void> {
  await provisionPreopCatalog(db)
  if (await activePreopProfile(db)) return
  const latest = await db.preopAssessmentProfile.findFirst({ orderBy: { version: "desc" }, select: { version: true } })
  const version = (latest?.version ?? 0) + 1
  await db.preopAssessmentProfile.create({
    data: {
      version,
      catalogVersion: PREOP_CATALOG_VERSION,
      status: PreopProfileStatus.PUBLISHED,
      publishedAt: new Date(),
      publishedById: actorId,
      questions: {
        create: BUNDLED_PREOP_QUESTIONS.map((item, sortOrder) => ({
          question: { connect: { stableKey: item.stableKey } },
          enabled: DEFAULT_ENABLED_QUESTION_KEYS.has(item.stableKey),
          required: item.requiredDefault,
          sortOrder,
        })),
      },
      auditEvents: { create: { actorId, action: "PROFILE_PUBLISHED", detail: json({ version, initial: true }) } },
    },
  })
}

export async function publishPreopProfile(
  db: Db,
  actorId: string,
  requested: ProfileQuestionInput[],
) {
  await provisionPreopCatalog(db)
  const current = await activePreopProfile(db)
  const configs = requested.length > 0
    ? profileCreateQuestions(requested)
    : BUNDLED_PREOP_QUESTIONS.map((item, sortOrder) => ({
        stableKey: item.stableKey,
        enabled: current?.questions.find((row: any) => row.question.stableKey === item.stableKey)?.enabled ?? DEFAULT_ENABLED_QUESTION_KEYS.has(item.stableKey),
        required: current?.questions.find((row: any) => row.question.stableKey === item.stableKey)?.required ?? item.requiredDefault,
        sortOrder,
      }))
  const latest = await db.preopAssessmentProfile.findFirst({ orderBy: { version: "desc" }, select: { version: true } })
  const version = (latest?.version ?? 0) + 1
  if (current) {
    await db.preopAssessmentProfile.updateMany({ where: { status: PreopProfileStatus.PUBLISHED }, data: { status: PreopProfileStatus.RETIRED } })
  }
  const profile = await db.preopAssessmentProfile.create({
    data: {
      version,
      catalogVersion: PREOP_CATALOG_VERSION,
      status: PreopProfileStatus.PUBLISHED,
      publishedAt: new Date(),
      publishedById: actorId,
      questions: { create: configs.map(config => ({
        question: { connect: { stableKey: config.stableKey } },
        enabled: config.enabled,
        required: config.required,
        sortOrder: config.sortOrder,
      })) },
      auditEvents: { create: { actorId, action: "PROFILE_PUBLISHED", detail: json({ version, previousVersion: current?.version ?? null }) } },
    },
    include: { questions: { include: { question: { include: { options: true } } } } },
  })
  return profile
}

function stateForLegacy(value: unknown): PreopAnswerState {
  return value === true ? PreopAnswerState.YES : value === false ? PreopAnswerState.NO : PreopAnswerState.NOT_ASKED
}

const LEGACY_BOOLEAN_QUESTIONS: Record<string, string> = {
  allergies: "BASE_ALLERGIES",
  latexAllergy: "BASE_LATEX_ALLERGY",
  familyAnesthesiaProblems: "BASE_FAMILY_ANAESTHESIA_PROBLEMS",
  unexplainedAnaesthesiaComplications: "BASE_UNEXPLAINED_ANAESTHESIA_COMPLICATIONS",
  malignantHyperthermiaHistory: "BASE_MALIGNANT_HYPERTHERMIA_HISTORY",
  anticipatedDifficultAirway: "BASE_ANTICIPATED_DIFFICULT_AIRWAY",
  dentalProsthetics: "BASE_DENTAL_PROSTHETICS",
  looseTeeth: "BASE_LOOSE_TEETH",
  smoking: "BASE_SMOKING",
  substanceAbuse: "BASE_SUBSTANCE_ABUSE",
  heartArrhythmia: "BASE_HEART_ARRHYTHMIA",
  rcriIschemicHeart: "BASE_RCRI_ISCHEMIC_HEART",
  rcriCHF: "BASE_RCRI_CHF",
  rcriCVD: "BASE_RCRI_CVD",
  rcriInsulinDM: "BASE_RCRI_INSULIN_DM",
  rcriCreatinine: "BASE_RCRI_CREATININE",
  apfelPONVHistory: "BASE_APFEL_PONV_HISTORY",
  apfelPostopOpioids: "BASE_APFEL_POSTOP_OPIOIDS",
  stopbangSnoring: "BASE_STOPBANG_SNORING",
  stopbangTired: "BASE_STOPBANG_TIRED",
  stopbangObserved: "BASE_STOPBANG_OBSERVED",
  stopbangBP: "BASE_STOPBANG_BP",
  stopbangNeck: "BASE_STOPBANG_NECK",
  povocSurgeryAtLeast30Minutes: "BASE_POVOC_SURGERY_30_MINUTES",
  povocStrabismusSurgery: "BASE_POVOC_STRABISMUS_SURGERY",
  povocHistory: "BASE_POVOC_HISTORY",
  coldsApplicable: "BASE_COLDS_APPLICABLE",
}

export function legacyAnswers(preop: Record<string, unknown>): PreopAnswerInput[] {
  const answers: PreopAnswerInput[] = []
  for (const [field, stableKey] of Object.entries(LEGACY_BOOLEAN_QUESTIONS)) {
    if (Object.prototype.hasOwnProperty.call(preop, field)) answers.push({ stableKey, state: stateForLegacy(preop[field]) })
  }
  if (Object.prototype.hasOwnProperty.call(preop, "elective") || Object.prototype.hasOwnProperty.call(preop, "emergencySurgery")) {
    const elective = preop.elective === true
    const emergency = preop.emergencySurgery === true
    if (elective && emergency) throw new PreopContractError("MUTUALLY_EXCLUSIVE_SURGERY_URGENCY")
    if (elective || emergency) answers.push({ stableKey: "BASE_SURGERY_URGENCY", state: PreopAnswerState.YES, optionKey: emergency ? "EMERGENCY" : "ELECTIVE" })
  }
  if (Object.prototype.hasOwnProperty.call(preop, "highRiskSurgery")) {
    answers.push({ stableKey: "BASE_SURGERY_RISK", state: PreopAnswerState.YES, optionKey: preop.highRiskSurgery === true ? "HIGH" : "LOW" })
  }
  return answers
}

function validateAnswer(profile: any, input: PreopAnswerInput, byKey: Map<string, any>): any {
  const row = byKey.get(input.stableKey)
  if (!row || !row.enabled) throw new PreopContractError("PREOP_QUESTION_NOT_ENABLED", { stableKey: input.stableKey })
  if (input.state === PreopAnswerState.NOT_ASKED) throw new PreopContractError("NOT_ASKED_IS_SERVER_GENERATED", { stableKey: input.stableKey })
  if (input.state === PreopAnswerState.UNKNOWN && !row.question.allowUnknown) throw new PreopContractError("UNKNOWN_NOT_ALLOWED", { stableKey: input.stableKey })
  if (input.state === PreopAnswerState.NOT_APPLICABLE && !row.question.allowNotApplicable) throw new PreopContractError("NOT_APPLICABLE_NOT_ALLOWED", { stableKey: input.stableKey })
  if ((input.state === PreopAnswerState.YES || input.state === PreopAnswerState.NO) && input.optionKey) {
    const option = row.question.options.find((value: any) => value.key === input.optionKey)
    if (!option) throw new PreopContractError("UNKNOWN_PREOP_ANSWER_OPTION", { stableKey: input.stableKey, optionKey: input.optionKey })
  }
  return row
}

export async function pinPreopProfile(
  db: Db,
  caseId: string,
  actorId: string,
  requestedVersion?: number,
  adopt = false,
) {
  const current = await db.preopCaseProfilePin.findUnique({ where: { caseId } })
  const active = await activePreopProfile(db)
  if (!active) throw new PreopContractError("PREOP_PROFILE_NOT_PROVISIONED")
  if (!current) {
    if (requestedVersion != null && requestedVersion !== active.version) throw new PreopContractError("PREOP_PROFILE_NOT_ACTIVE", { version: requestedVersion })
    const pin = await db.preopCaseProfilePin.create({ data: { caseId, profileId: active.id, profileVersion: active.version, pinnedById: actorId } })
    await db.preopAssessmentAuditEvent.create({ data: { caseId, profileId: active.id, actorId, action: "CASE_PROFILE_PINNED", detail: json({ version: active.version }) } })
    return { pin, profile: active }
  }
  if (requestedVersion != null && requestedVersion !== current.profileVersion) {
    if (!adopt) throw new PreopContractError("PREOP_PROFILE_CHANGE_REQUIRES_EXPLICIT_ADOPTION", { currentVersion: current.profileVersion, requestedVersion })
    if (requestedVersion !== active.version) throw new PreopContractError("PREOP_PROFILE_NOT_ACTIVE", { version: requestedVersion })
    const pin = await db.preopCaseProfilePin.update({ where: { caseId }, data: { profileId: active.id, profileVersion: active.version, adoptedAt: new Date(), adoptedById: actorId } })
    await db.preopAssessmentAuditEvent.create({ data: { caseId, profileId: active.id, actorId, action: "CASE_PROFILE_ADOPTED", detail: json({ fromVersion: current.profileVersion, toVersion: active.version }) } })
    return { pin, profile: active }
  }
  const profile = await db.preopAssessmentProfile.findUnique({ where: { id: current.profileId }, include: { questions: { include: { question: { include: { options: { orderBy: { sortOrder: "asc" } } } } }, orderBy: { sortOrder: "asc" } } } })
  if (!profile) throw new PreopContractError("PREOP_PINNED_PROFILE_MISSING", { version: current.profileVersion })
  return { pin: current, profile }
}

export async function savePreopAnswers(
  db: Db,
  args: {
    caseId: string
    preopId: string
    actorId: string
    preop?: Record<string, unknown>
    answers?: PreopAnswerInput[]
    requestedProfileVersion?: number
    adoptProfile?: boolean
  },
) {
  const { profile, pin } = await pinPreopProfile(db, args.caseId, args.actorId, args.requestedProfileVersion, args.adoptProfile)
  const submitted = [...legacyAnswers(args.preop ?? {}), ...(args.answers ?? [])]
  const mode = args.preop?.clinicalMode === "PEDIATRIC" || args.preop?.clinicalMode === "ADULT"
    ? args.preop.clinicalMode
    : null
  if (mode) {
    const otherMode = mode === "PEDIATRIC" ? "ADULT" : "PEDIATRIC"
    const otherQuestionIds = profile.questions
      .filter((row: any) => row.question.applicability.includes(otherMode))
      .map((row: any) => row.questionId)
    if (otherQuestionIds.length > 0) {
      await db.preopAssessmentAnswer.deleteMany({
        where: { preopId: args.preopId, questionId: { in: otherQuestionIds } },
      })
    }
  }
  const byKey = new Map<string, any>(profile.questions.map((row: any) => [row.question.stableKey, row] as [string, any]))
  const deduped = new Map<string, PreopAnswerInput>()
  for (const answer of submitted) {
    validateAnswer(profile, answer, byKey)
    deduped.set(answer.stableKey, answer)
  }
  const writes = profile.questions.filter((row: any) => row.enabled).map((row: any) => {
    const answer = deduped.get(row.question.stableKey)
    if (!answer && row.required) throw new PreopContractError("REQUIRED_PREOP_QUESTION_UNANSWERED", { stableKey: row.question.stableKey })
    const state = answer?.state ?? PreopAnswerState.NOT_ASKED
    return {
      preopId: args.preopId,
      questionId: row.questionId,
      profileId: profile.id,
      profileVersion: pin.profileVersion,
      state,
      optionKey: answer?.optionKey ?? null,
      valueText: answer?.valueText ?? null,
      valueNumber: answer?.valueNumber ?? null,
      valueDate: answer?.valueDate ? new Date(answer.valueDate) : null,
      source: answer ? "clinician" : "schema",
      provenance: json(answer ? { source: "clinician" } : { source: "schema", reason: "optional_unanswered" }),
      authorId: args.actorId,
    }
  })
  for (const data of writes) {
    await db.preopAssessmentAnswer.upsert({
      where: { preopId_questionId_profileVersion: { preopId: data.preopId, questionId: data.questionId, profileVersion: data.profileVersion } },
      create: data,
      update: data,
    })
  }
  return { profile, pin, answersWritten: writes.length }
}

export function serializePreopProfile(profile: any): PreopProfileShape {
  return {
    id: profile.id,
    version: profile.version,
    catalogVersion: profile.catalogVersion,
    status: profile.status,
    publishedAt: profile.publishedAt,
    questions: profile.questions.map((row: any) => ({
      stableKey: row.question.stableKey,
      enabled: row.enabled,
      required: row.required,
      sortOrder: row.sortOrder,
      labelEn: row.question.labelEn,
      labelBg: row.question.labelBg,
      answerType: row.question.answerType,
      applicability: row.question.applicability,
      allowUnknown: row.question.allowUnknown,
      allowNotApplicable: row.question.allowNotApplicable,
      conditionalRuleKey: row.question.conditionalRuleKey,
      omopDomain: row.question.omopDomain,
      omopConceptId: row.question.omopConceptId,
      omopSourceCode: row.question.omopSourceCode,
      options: row.question.options.map((option: any) => ({
        key: option.key,
        labelEn: option.labelEn,
        labelBg: option.labelBg,
        omopConceptId: option.omopConceptId,
        omopVocabulary: option.omopVocabulary,
        omopSourceCode: option.omopSourceCode,
      })),
    })),
  }
}
