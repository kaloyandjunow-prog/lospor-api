import { randomUUID } from "node:crypto"
import { Prisma, PreopAnswerState, PreopProfileStatus, type PrismaClient } from "@/generated/prisma/client"
import {
  BUNDLED_PREOP_QUESTIONS,
  DEFAULT_ENABLED_QUESTION_KEYS,
  PREOP_CATALOG_VERSION,
  bundledQuestion,
  type PreopCatalogQuestion,
  type PreopFormSection,
} from "./catalog"
import { hasDedicatedPreopControl, PREOP_LEGACY_FIELD_BY_QUESTION } from "@lospor/core/preop-assessment"

/**
 * The preoperative assessment: one bundled catalogue, one appliance profile.
 *
 * The catalogue is software. It ships with the release and the database copy
 * follows it. Operators configure one profile -- which questions are on, their
 * order, and which are required -- and change it in place. There are no profile
 * versions and nothing to adopt.
 *
 * What was asked in a case is recorded by the answer rows themselves: a
 * question that was on has a row (the answer, or NOT_ASKED while unanswered);
 * a question that was off has none.
 */

type Db = Prisma.TransactionClient | PrismaClientLike
type PrismaClientLike = Pick<PrismaClient, "$executeRaw" | "preopQuestionDefinition" | "preopAnswerOption" | "preopAssessmentProfile" | "preopProfileQuestion" | "preopAssessmentAnswer" | "preopAssessmentAuditEvent" | "preopAssessmentSuggestion">

type PreopQuestionOptionRow = {
  key: string
  labelEn: string
  labelBg: string
  omopConceptId: number | null
  omopVocabulary: string | null
  omopSourceCode: string | null
}

type PreopProfileQuestionRow = {
  questionId: string
  enabled: boolean
  required: boolean
  sortOrder: number
  question: {
    stableKey: string
    allowUnknown: boolean
    allowNotApplicable: boolean
    applicability: string[]
    options: PreopQuestionOptionRow[]
    labelEn: string
    labelBg: string
    answerType: string
    section: string
    conditionalRuleKey: string | null
    omopDomain: string | null
    omopConceptId: number | null
    omopSourceCode: string | null
  }
}

type PreopProfileRow = {
  id: string
  version: number
  catalogVersion: string
  status: string
  publishedAt: Date | null
  questions: PreopProfileQuestionRow[]
}

export type PreopDb = Db

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
    section: string
    formSection: PreopFormSection
    parentKey: string | null
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

/** Wire `code` of a refused preop answer; `reason` carries the contract code. */
export const PREOP_ANSWER_REFUSED = "PREOP_ANSWER_REFUSED"

/**
 * The preop payload keys a clinician must change before this refusal can
 * succeed, or null when no edit can fix it (a catalogue or profile fault on the
 * appliance itself). Clients quarantine exactly these keys instead of replaying
 * the whole section forever.
 */
export function preopContractBlockedKeys(error: PreopContractError): string[] | null {
  switch (error.code) {
    case "MUTUALLY_EXCLUSIVE_SURGERY_URGENCY":
      return ["elective", "emergencySurgery"]
    case "UNKNOWN_PREOP_QUESTION":
    case "NOT_ASKED_IS_SERVER_GENERATED":
    case "UNKNOWN_NOT_ALLOWED":
    case "NOT_APPLICABLE_NOT_ALLOWED":
    case "UNKNOWN_PREOP_ANSWER_OPTION":
      return typeof error.details.stableKey === "string"
        ? preopPayloadKeysForQuestion(error.details.stableKey)
        : ["preopAnswers"]
    default:
      return null
  }
}

function json(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  return value == null ? Prisma.JsonNull : value as Prisma.InputJsonValue
}

function catalogData(item: PreopCatalogQuestion) {
  return {
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

function optionData(option: PreopCatalogQuestion["options"][number], sortOrder: number) {
  return {
    labelEn: option.labelEn,
    labelBg: option.labelBg,
    omopConceptId: option.omopConceptId ?? null,
    omopVocabulary: option.omopVocabulary ?? null,
    omopSourceCode: option.omopSourceCode ?? null,
    sortOrder,
  }
}

type StoredCatalogQuestion = ReturnType<typeof catalogData> & {
  stableKey: string
  options: Array<ReturnType<typeof optionData> & { key: string }>
}

/** Whether the stored catalogue already says exactly what the bundle says. */
function catalogMatches(stored: StoredCatalogQuestion[]): boolean {
  const byKey = new Map(stored.map(row => [row.stableKey, row]))
  return BUNDLED_PREOP_QUESTIONS.every(item => {
    const row = byKey.get(item.stableKey)
    if (!row) return false
    const expected = catalogData(item)
    const sameQuestion = (Object.keys(expected) as Array<keyof typeof expected>).every(field =>
      field === "applicability"
        ? row.applicability.join("\u0000") === expected.applicability.join("\u0000")
        : row[field] === expected[field])
    return sameQuestion && item.options.every((option, sortOrder) => {
      const found = row.options.find(value => value.key === option.key)
      const wanted = optionData(option, sortOrder)
      return !!found && (Object.keys(wanted) as Array<keyof typeof wanted>).every(field => found[field] === wanted[field])
    })
  })
}

/**
 * Bring the database copy of the catalogue in line with the bundle.
 *
 * The bundle is the only catalogue; the tables exist so answers can reference
 * a question and an option relationally. Options are never deleted -- an
 * answer may reference one -- only added or updated.
 *
 * One read, and when anything differs two statements: the questions, then
 * their options, each as a single INSERT ... ON CONFLICT DO UPDATE. This runs
 * inside a clinician's save after an upgrade, and row-by-row upserts (about
 * 300 round trips) outlived the 5-second transaction on a hosted database, so
 * every save failed and the upgrade never completed.
 */
export async function provisionPreopCatalog(db: Db): Promise<void> {
  const stored = await db.preopQuestionDefinition.findMany({
    select: {
      stableKey: true, catalogVersion: true, section: true, applicability: true, answerType: true,
      labelEn: true, labelBg: true, requiredDefault: true, allowUnknown: true, allowNotApplicable: true,
      conditionalRuleKey: true, omopDomain: true, omopConceptId: true, omopVocabulary: true, omopSourceCode: true,
      options: {
        select: {
          key: true, labelEn: true, labelBg: true, omopConceptId: true, omopVocabulary: true,
          omopSourceCode: true, sortOrder: true,
        },
      },
    },
  })
  if (catalogMatches(stored as StoredCatalogQuestion[])) return

  const questions = BUNDLED_PREOP_QUESTIONS.map(item => {
    const data = catalogData(item)
    return Prisma.sql`(${randomUUID()}, ${item.stableKey}, ${data.catalogVersion}, ${data.section},
      ${data.applicability}::text[], ${data.answerType}::"PreopAnswerType", ${data.labelEn}, ${data.labelBg},
      ${data.requiredDefault}, ${data.allowUnknown}, ${data.allowNotApplicable}, ${data.conditionalRuleKey}::text,
      ${data.omopDomain}::text, ${data.omopConceptId}::int, ${data.omopVocabulary}::text, ${data.omopSourceCode}::text)`
  })
  await db.$executeRaw`
    INSERT INTO "PreopQuestionDefinition" (
      "id", "stableKey", "catalogVersion", "section", "applicability", "answerType", "labelEn", "labelBg",
      "requiredDefault", "allowUnknown", "allowNotApplicable", "conditionalRuleKey",
      "omopDomain", "omopConceptId", "omopVocabulary", "omopSourceCode"
    )
    VALUES ${Prisma.join(questions)}
    ON CONFLICT ("stableKey") DO UPDATE SET
      "catalogVersion" = EXCLUDED."catalogVersion",
      "section" = EXCLUDED."section",
      "applicability" = EXCLUDED."applicability",
      "answerType" = EXCLUDED."answerType",
      "labelEn" = EXCLUDED."labelEn",
      "labelBg" = EXCLUDED."labelBg",
      "requiredDefault" = EXCLUDED."requiredDefault",
      "allowUnknown" = EXCLUDED."allowUnknown",
      "allowNotApplicable" = EXCLUDED."allowNotApplicable",
      "conditionalRuleKey" = EXCLUDED."conditionalRuleKey",
      "omopDomain" = EXCLUDED."omopDomain",
      "omopConceptId" = EXCLUDED."omopConceptId",
      "omopVocabulary" = EXCLUDED."omopVocabulary",
      "omopSourceCode" = EXCLUDED."omopSourceCode"`

  const options = BUNDLED_PREOP_QUESTIONS.flatMap(item => item.options.map((option, sortOrder) => {
    const data = optionData(option, sortOrder)
    return Prisma.sql`(${randomUUID()}, ${item.stableKey}, ${option.key}, ${data.labelEn}, ${data.labelBg},
      ${data.omopConceptId}::int, ${data.omopVocabulary}::text, ${data.omopSourceCode}::text, ${data.sortOrder}::int)`
  }))
  await db.$executeRaw`
    INSERT INTO "PreopAnswerOption" (
      "id", "questionId", "key", "labelEn", "labelBg", "omopConceptId", "omopVocabulary", "omopSourceCode", "sortOrder"
    )
    SELECT bundled."id", definition."id", bundled."key", bundled."labelEn", bundled."labelBg",
      bundled."omopConceptId", bundled."omopVocabulary", bundled."omopSourceCode", bundled."sortOrder"
    FROM (VALUES ${Prisma.join(options)}) AS bundled (
      "id", "stableKey", "key", "labelEn", "labelBg", "omopConceptId", "omopVocabulary", "omopSourceCode", "sortOrder"
    )
    JOIN "PreopQuestionDefinition" definition ON definition."stableKey" = bundled."stableKey"
    ON CONFLICT ("questionId", "key") DO UPDATE SET
      "labelEn" = EXCLUDED."labelEn",
      "labelBg" = EXCLUDED."labelBg",
      "omopConceptId" = EXCLUDED."omopConceptId",
      "omopVocabulary" = EXCLUDED."omopVocabulary",
      "omopSourceCode" = EXCLUDED."omopSourceCode",
      "sortOrder" = EXCLUDED."sortOrder"`
}

const PROFILE_INCLUDE = {
  questions: {
    include: { question: { include: { options: { orderBy: { sortOrder: "asc" } } } } },
    orderBy: { sortOrder: "asc" },
  },
} as const

export async function activePreopProfile(db: Db) {
  return db.preopAssessmentProfile.findFirst({
    where: { status: PreopProfileStatus.PUBLISHED },
    orderBy: { version: "desc" },
    include: PROFILE_INCLUDE,
  })
}

async function lockProfile(db: Db): Promise<void> {
  // Only a transaction client can hold an xact lock. Serialises the first
  // save on a fresh appliance, a catalogue upgrade, and an operator's change.
  if ("$executeRaw" in db) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('lospor-preop-profile'))`
  }
}

/**
 * The appliance's one profile, created with the bundled defaults on first use
 * and brought up to the bundled catalogue after an upgrade.
 *
 * Fast path: a profile already recorded against this catalogue version with
 * every bundled question is returned without touching the catalogue, so an
 * ordinary preop save costs one read.
 */
/**
 * Puts the catalogue and the profile in place in a transaction of their own.
 *
 * Call it before opening a clinical write transaction. Creating the profile on
 * a fresh database, or upgrading the catalogue after a release, is a one-off
 * set of writes that must never run inside a clinician's save: that transaction
 * has 5 seconds, and a hosted database far from the API spends most of it on
 * round trips. Afterwards the save finds the profile on its fast path.
 */
export async function preparePreopProfile(
  client: { $transaction: PrismaClient["$transaction"] },
  actorId: string,
): Promise<void> {
  await client.$transaction(tx => ensurePreopProfile(tx, actorId), { maxWait: 10_000, timeout: 30_000 })
}

export async function ensurePreopProfile(db: Db, actorId: string): Promise<PreopProfileRow> {
  const current = await activePreopProfile(db)
  if (current && current.catalogVersion === PREOP_CATALOG_VERSION
    && current.questions.length === BUNDLED_PREOP_QUESTIONS.length) {
    return current
  }
  await lockProfile(db)
  await provisionPreopCatalog(db)
  const profile = await activePreopProfile(db)
  if (!profile) {
    // Flat writes, not a nested create: a nested create resolves each of the
    // 75 question connects with its own queries (172 in all), which took 16 s
    // at the ~90 ms round trip between the hosted API and its database and
    // outlived the save's 5-second transaction. This is five statements.
    const latest = await db.preopAssessmentProfile.findFirst({ orderBy: { version: "desc" }, select: { version: true } })
    const created = await db.preopAssessmentProfile.create({
      data: {
        version: (latest?.version ?? 0) + 1,
        catalogVersion: PREOP_CATALOG_VERSION,
        status: PreopProfileStatus.PUBLISHED,
        publishedAt: new Date(),
        publishedById: actorId,
      },
      select: { id: true },
    })
    const definitions = await db.preopQuestionDefinition.findMany({ select: { id: true, stableKey: true } })
    const idOf = new Map(definitions.map(row => [row.stableKey, row.id]))
    await db.preopProfileQuestion.createMany({
      data: BUNDLED_PREOP_QUESTIONS.map((item, sortOrder) => ({
        profileId: created.id,
        questionId: idOf.get(item.stableKey)!,
        enabled: DEFAULT_ENABLED_QUESTION_KEYS.has(item.stableKey),
        required: item.requiredDefault,
        sortOrder,
      })),
    })
    await db.preopAssessmentAuditEvent.create({
      data: { profileId: created.id, actorId, action: "PROFILE_CREATED", detail: json({ catalogVersion: PREOP_CATALOG_VERSION }) },
    })
  } else {
    // A release that adds questions adds them switched off, after the
    // operator's existing order. Nothing the operator chose is changed.
    const present = new Set(profile.questions.map(row => row.question.stableKey))
    const added = BUNDLED_PREOP_QUESTIONS.map(item => item.stableKey).filter(key => !present.has(key))
    if (added.length > 0) {
      // One read and one insert, however many questions a release adds.
      const definitions = await db.preopQuestionDefinition.findMany({
        where: { stableKey: { in: added } },
        select: { id: true, stableKey: true },
      })
      const idOf = new Map(definitions.map(row => [row.stableKey, row.id]))
      const first = profile.questions.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1
      await db.preopProfileQuestion.createMany({
        data: added.map((stableKey, index) => ({
          profileId: profile.id,
          questionId: idOf.get(stableKey)!,
          enabled: false,
          required: false,
          sortOrder: first + index,
        })),
      })
    }
    await db.preopAssessmentProfile.update({ where: { id: profile.id }, data: { catalogVersion: PREOP_CATALOG_VERSION } })
    await db.preopAssessmentAuditEvent.create({
      data: {
        profileId: profile.id,
        actorId,
        action: "CATALOG_UPGRADED",
        detail: json({ from: profile.catalogVersion, to: PREOP_CATALOG_VERSION, added }),
      },
    })
  }
  const result = await activePreopProfile(db)
  if (!result) throw new PreopContractError("PREOP_PROFILE_NOT_PROVISIONED")
  return result
}

/**
 * An operator's change to the profile, applied in place and audited.
 *
 * Every bundled question must be listed, exactly once, with a unique order.
 * Cases in progress see the change on their next load; the answers already
 * recorded are never touched here (see savePreopAnswers for what happens to a
 * case's rows on its next save).
 */
export async function updatePreopProfile(
  db: Db,
  actorId: string,
  requested: ProfileQuestionInput[],
  reason: string,
): Promise<PreopProfileRow> {
  await lockProfile(db)
  const profile = await ensurePreopProfile(db, actorId)
  const seen = new Set<string>()
  const seenOrders = new Set<number>()
  for (const config of requested) {
    if (!bundledQuestion(config.stableKey)) throw new PreopContractError("UNKNOWN_PREOP_QUESTION", { stableKey: config.stableKey })
    if (seen.has(config.stableKey)) throw new PreopContractError("DUPLICATE_PREOP_QUESTION", { stableKey: config.stableKey })
    seen.add(config.stableKey)
    if (!config.enabled && config.required) throw new PreopContractError("DISABLED_QUESTION_CANNOT_BE_REQUIRED", { stableKey: config.stableKey })
    if (!Number.isSafeInteger(config.sortOrder) || config.sortOrder < 0) throw new PreopContractError("INVALID_PREOP_QUESTION_ORDER", { stableKey: config.stableKey })
    if (seenOrders.has(config.sortOrder)) throw new PreopContractError("DUPLICATE_PREOP_QUESTION_ORDER", { sortOrder: config.sortOrder })
    seenOrders.add(config.sortOrder)
  }
  if (seen.size !== BUNDLED_PREOP_QUESTIONS.length) throw new PreopContractError("PREOP_PROFILE_CATALOG_INCOMPLETE")

  const byKey = new Map(profile.questions.map(row => [row.question.stableKey, row]))
  const changes: Array<{ stableKey: string; before: ProfileQuestionInput; after: ProfileQuestionInput }> = []
  for (const config of requested) {
    const row = byKey.get(config.stableKey)!
    if (row.enabled === config.enabled && row.required === config.required && row.sortOrder === config.sortOrder) continue
    await db.preopProfileQuestion.update({
      where: { profileId_questionId: { profileId: profile.id, questionId: row.questionId } },
      data: { enabled: config.enabled, required: config.required, sortOrder: config.sortOrder },
    })
    changes.push({
      stableKey: config.stableKey,
      before: { stableKey: config.stableKey, enabled: row.enabled, required: row.required, sortOrder: row.sortOrder },
      after: config,
    })
  }
  await db.preopAssessmentAuditEvent.create({
    data: { profileId: profile.id, actorId, action: "PROFILE_UPDATED", detail: json({ reason, changes }) },
  })
  const result = await activePreopProfile(db)
  if (!result) throw new PreopContractError("PREOP_PROFILE_NOT_PROVISIONED")
  return result
}

/** Legacy preop field -> baseline question, from the map core shares with the clients. */
const LEGACY_BOOLEAN_QUESTIONS: Record<string, string> = Object.fromEntries(
  Object.entries(PREOP_LEGACY_FIELD_BY_QUESTION).map(([stableKey, field]) => [field, stableKey]),
)

/** The legacy preop field that mirrors a baseline question, if any. */
export function legacyFieldForQuestion(stableKey: string): string | null {
  return Object.entries(LEGACY_BOOLEAN_QUESTIONS).find(([, key]) => key === stableKey)?.[0] ?? null
}

/**
 * The preop payload keys a question's answer arrives in, so a refused answer
 * can name the form fields the clinician has to revisit.
 */
export function preopPayloadKeysForQuestion(stableKey: string): string[] {
  if (stableKey === "BASE_SURGERY_URGENCY") return ["elective", "emergencySurgery"]
  if (stableKey === "BASE_SURGERY_RISK") return ["highRiskSurgery"]
  const legacy = legacyFieldForQuestion(stableKey)
  return legacy ? [legacy] : ["preopAnswers"]
}

/**
 * Legacy yes/no controls are tri-state on every client: `null` is "not
 * answered yet", the form's own default. It is not an answer, and it must not
 * be turned into a client-submitted NOT_ASKED (which validateAnswer refuses).
 */
export function legacyAnswers(preop: Record<string, unknown>): PreopAnswerInput[] {
  const answers: PreopAnswerInput[] = []
  for (const [field, stableKey] of Object.entries(LEGACY_BOOLEAN_QUESTIONS)) {
    const value = preop[field]
    // coldsApplicable is not tri-state: it is a Boolean defaulting to false,
    // so a false means "not applicable, or nobody looked". Only a true is an
    // answer.
    if (field === "coldsApplicable" && value !== true) continue
    if (value === true || value === false) {
      answers.push({ stableKey, state: value ? PreopAnswerState.YES : PreopAnswerState.NO })
    }
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

/** Questions whose legacy control was explicitly set back to "not answered" in this payload. */
export function legacyClearedQuestions(preop: Record<string, unknown>): Set<string> {
  const cleared = new Set<string>()
  for (const [field, stableKey] of Object.entries(LEGACY_BOOLEAN_QUESTIONS)) {
    if (Object.prototype.hasOwnProperty.call(preop, field) && preop[field] === null) cleared.add(stableKey)
  }
  const hasUrgency = Object.prototype.hasOwnProperty.call(preop, "elective")
    || Object.prototype.hasOwnProperty.call(preop, "emergencySurgery")
  if (hasUrgency && preop.elective !== true && preop.emergencySurgery !== true) cleared.add("BASE_SURGERY_URGENCY")
  return cleared
}

function validateAnswer(input: PreopAnswerInput, row: PreopProfileQuestionRow | undefined): PreopProfileQuestionRow {
  if (!row) throw new PreopContractError("UNKNOWN_PREOP_QUESTION", { stableKey: input.stableKey })
  if (input.state === PreopAnswerState.NOT_ASKED) throw new PreopContractError("NOT_ASKED_IS_SERVER_GENERATED", { stableKey: input.stableKey })
  if (input.state === PreopAnswerState.UNKNOWN && !row.question.allowUnknown) throw new PreopContractError("UNKNOWN_NOT_ALLOWED", { stableKey: input.stableKey })
  if (input.state === PreopAnswerState.NOT_APPLICABLE && !row.question.allowNotApplicable) throw new PreopContractError("NOT_APPLICABLE_NOT_ALLOWED", { stableKey: input.stableKey })
  if ((input.state === PreopAnswerState.YES || input.state === PreopAnswerState.NO) && input.optionKey) {
    const option = row.question.options.find(value => value.key === input.optionKey)
    if (!option) throw new PreopContractError("UNKNOWN_PREOP_ANSWER_OPTION", { stableKey: input.stableKey, optionKey: input.optionKey })
  }
  return row
}

/** Whether a question belongs to a case of this clinical mode (unknown mode: every question). */
export function questionAppliesToMode(applicability: readonly string[], mode: string | null | undefined): boolean {
  return applicability.length === 0 || !mode || applicability.includes(mode)
}

type StoredAnswer = {
  questionId: string
  state: PreopAnswerState
  optionKey: string | null
  valueText: string | null
  valueNumber: number | null
  valueDate: Date | null
}

/**
 * A plain yes/no answer names its option after its state. The forms send
 * `optionKey: "YES"`; an accepted suggestion used to be stored with none. Read
 * both the same way, or the form's copy of an accepted suggestion looks like a
 * new answer on the next autosave and rewrites it as the clinician's, losing
 * the provenance (for weight loss, the link that stops a second OMOP condition).
 */
export function effectiveOptionKey(state: PreopAnswerState | string, optionKey: string | null | undefined): string | null {
  if (optionKey) return optionKey
  return state === PreopAnswerState.YES || state === PreopAnswerState.NO ? state : null
}

function sameAnswer(stored: StoredAnswer | undefined, answer: PreopAnswerInput): boolean {
  return stored != null
    && stored.state === answer.state
    && effectiveOptionKey(stored.state, stored.optionKey) === effectiveOptionKey(answer.state, answer.optionKey)
    && stored.valueText === (answer.valueText ?? null)
    && stored.valueNumber === (answer.valueNumber ?? null)
    && (stored.valueDate?.toISOString() ?? null) === (answer.valueDate ? new Date(answer.valueDate).toISOString() : null)
}

/**
 * Record a preop save in the answer rows.
 *
 * Autosave sends only what changed, so a question missing from the request is
 * not an answer being withdrawn. The rules, per question:
 *
 * - On for this case (enabled and applicable to its mode): has a row. A
 *   submitted answer is written; otherwise a NOT_ASKED row is created if none
 *   exists. A legacy toggle set back to "not answered" resets it to NOT_ASKED.
 * - Off: no NOT_ASKED row (one left from when it was on is removed). A real
 *   answer already recorded is kept. An answer that arrives for it anyway --
 *   a device that was offline when the operator switched it off -- is stored
 *   and marked as such: clinical data is never thrown away. Legacy toggles for
 *   an off question with no row are not turned into rows; the form hid them.
 * - Follow-ups exist only while their parent is YES; otherwise they are
 *   NOT_ASKED (on) or absent (off).
 *
 * An answer identical to the stored one is not rewritten, so a client that
 * resends every answer cannot turn an accepted suggestion into a clinician
 * answer or change who recorded it.
 */
export async function savePreopAnswers(
  db: Db,
  args: {
    caseId: string
    preopId: string
    actorId: string
    preop?: Record<string, unknown>
    answers?: PreopAnswerInput[]
    /** The case's mode when the payload does not carry one. */
    clinicalMode?: string | null
  },
) {
  const profile = await ensurePreopProfile(db, args.actorId)
  const preop = args.preop ?? {}
  const payloadMode = preop.clinicalMode === "PEDIATRIC" || preop.clinicalMode === "ADULT" ? preop.clinicalMode : null
  const mode = payloadMode ?? args.clinicalMode ?? null
  if (payloadMode) {
    // A case switched to the other population keeps none of that population's
    // answers: they describe a patient the case no longer says it is.
    const otherMode = payloadMode === "PEDIATRIC" ? "ADULT" : "PEDIATRIC"
    const otherQuestionIds = profile.questions
      .filter(row => row.question.applicability.includes(otherMode))
      .map(row => row.questionId)
    if (otherQuestionIds.length > 0) {
      await db.preopAssessmentAnswer.deleteMany({
        where: { preopId: args.preopId, questionId: { in: otherQuestionIds } },
      })
    }
  }

  const byKey = new Map<string, PreopProfileQuestionRow>(profile.questions.map(row => [row.question.stableKey, row]))
  const submitted = new Map<string, { answer: PreopAnswerInput; explicit: boolean }>()
  for (const answer of legacyAnswers(preop)) {
    validateAnswer(answer, byKey.get(answer.stableKey))
    submitted.set(answer.stableKey, { answer, explicit: false })
  }
  for (const answer of args.answers ?? []) {
    // A baseline question is answered through its own form field only. A copy
    // of it in preopAnswers is at best redundant and at worst stale (a form
    // that loaded the answer, then had the toggle changed), so it is ignored.
    if (hasDedicatedPreopControl(answer.stableKey)) continue
    validateAnswer(answer, byKey.get(answer.stableKey))
    submitted.set(answer.stableKey, { answer, explicit: true })
  }
  const cleared = legacyClearedQuestions(preop)
  // preopAnswers, when sent, is the form's complete set of answers to the
  // questions without their own control: one it no longer holds was cleared.
  if (Array.isArray(args.answers)) {
    for (const row of profile.questions) {
      const key = row.question.stableKey
      if (!hasDedicatedPreopControl(key) && !submitted.has(key)) cleared.add(key)
    }
  }

  const stored = new Map<string, StoredAnswer>((await db.preopAssessmentAnswer.findMany({
    where: { preopId: args.preopId },
    select: { questionId: true, state: true, optionKey: true, valueText: true, valueNumber: true, valueDate: true },
  })).map(row => [row.questionId, row]))

  type Target = { kind: "answer"; answer: PreopAnswerInput; off: boolean } | { kind: "not-asked" } | { kind: "keep" } | { kind: "none" }
  const target = new Map<string, Target>()
  const finalState = new Map<string, PreopAnswerState | null>()
  const isOn = (row: PreopProfileQuestionRow) => row.enabled && questionAppliesToMode(row.question.applicability, mode)

  for (const row of profile.questions) {
    const key = row.question.stableKey
    const previous = stored.get(row.questionId)
    const on = isOn(row)
    const incoming = submitted.get(key)
    let decision: Target
    if (incoming && (on || incoming.explicit || previous)) {
      decision = { kind: "answer", answer: incoming.answer, off: !on }
    } else if (cleared.has(key) && !incoming && (on || !previous || previous.state === PreopAnswerState.NOT_ASKED)) {
      // An off question is hidden, so the form cannot have cleared it: a real
      // answer recorded while it was on stays.
      decision = on ? { kind: "not-asked" } : { kind: "none" }
    } else if (previous) {
      decision = !on && previous.state === PreopAnswerState.NOT_ASKED ? { kind: "none" } : { kind: "keep" }
    } else {
      decision = on ? { kind: "not-asked" } : { kind: "none" }
    }
    target.set(key, decision)
    finalState.set(key, decision.kind === "answer" ? decision.answer.state
      : decision.kind === "not-asked" ? PreopAnswerState.NOT_ASKED
        : decision.kind === "keep" ? previous!.state : null)
  }

  // Follow-ups only exist while the parent is YES.
  for (const row of profile.questions) {
    const parentKey = bundledQuestion(row.question.stableKey)?.parentKey
    if (!parentKey || finalState.get(parentKey) === PreopAnswerState.YES) continue
    const on = isOn(row)
    target.set(row.question.stableKey, on ? { kind: "not-asked" } : { kind: "none" })
  }

  // Writes are batched: this runs inside the case's save transaction, and a
  // case's first save creates a row for every question that is on (up to the
  // whole catalogue). One round trip per row is what outlived the 5-second
  // transaction on a hosted database during the catalogue upgrade.
  const notAsked = {
    profileId: profile.id,
    profileVersion: profile.version,
    state: PreopAnswerState.NOT_ASKED,
    optionKey: null,
    valueText: null,
    valueNumber: null,
    valueDate: null,
    source: "schema",
    provenance: json({ source: "schema", reason: "optional_unanswered" }),
    authorId: args.actorId,
  }
  const removed: string[] = []
  const resetToNotAsked: string[] = []
  const created: Prisma.PreopAssessmentAnswerCreateManyInput[] = []
  const changed: Array<{ questionId: string; data: Omit<Prisma.PreopAssessmentAnswerUncheckedCreateInput, "preopId" | "questionId"> }> = []

  for (const row of profile.questions) {
    const decision = target.get(row.question.stableKey)!
    const previous = stored.get(row.questionId)
    if (decision.kind === "keep") continue
    if (decision.kind === "none") {
      if (previous) removed.push(row.questionId)
      continue
    }
    if (decision.kind === "not-asked") {
      if (previous?.state === PreopAnswerState.NOT_ASKED) continue
      if (previous) resetToNotAsked.push(row.questionId)
      else created.push({ preopId: args.preopId, questionId: row.questionId, ...notAsked })
      continue
    }
    if (sameAnswer(previous, decision.answer)) continue
    const data = {
      profileId: profile.id,
      profileVersion: profile.version,
      state: decision.answer.state,
      optionKey: decision.answer.optionKey ?? null,
      valueText: decision.answer.valueText ?? null,
      valueNumber: decision.answer.valueNumber ?? null,
      valueDate: decision.answer.valueDate ? new Date(decision.answer.valueDate) : null,
      source: "clinician",
      provenance: json(decision.off ? { source: "clinician", recordedWhileQuestionOff: true } : { source: "clinician" }),
      authorId: args.actorId,
    }
    if (previous) changed.push({ questionId: row.questionId, data })
    else created.push({ preopId: args.preopId, questionId: row.questionId, ...data })
  }

  if (removed.length > 0) {
    await db.preopAssessmentAnswer.deleteMany({ where: { preopId: args.preopId, questionId: { in: removed } } })
  }
  if (resetToNotAsked.length > 0) {
    await db.preopAssessmentAnswer.updateMany({
      where: { preopId: args.preopId, questionId: { in: resetToNotAsked } },
      data: notAsked,
    })
  }
  if (created.length > 0) await db.preopAssessmentAnswer.createMany({ data: created })
  // Only answers the clinician actually changed; an autosave carries one or two.
  for (const { questionId, data } of changed) {
    await db.preopAssessmentAnswer.update({
      where: { preopId_questionId: { preopId: args.preopId, questionId } },
      data,
    })
  }
  return { profile, answersWritten: resetToNotAsked.length + created.length + changed.length }
}

export type MissingRequiredPreopQuestion = {
  stableKey: string
  labelEn: string
  labelBg: string
  /** Preop payload keys that answer it, so a client can take the clinician there. */
  fields: string[]
}

/**
 * Required questions that are on for this case and have no answer yet.
 *
 * This gates "continue to intraop", the step that has always held a preop back
 * for missing required fields. Saving a draft is never refused for it.
 */
export function missingRequiredPreopQuestions(
  profile: { questions: Array<Pick<PreopProfileQuestionRow, "questionId" | "enabled" | "required"> & {
    question: Pick<PreopProfileQuestionRow["question"], "stableKey" | "labelEn" | "labelBg" | "applicability">
  }> } | null | undefined,
  answers: ReadonlyArray<{ questionId: string; state: string }> | null | undefined,
  clinicalMode: string | null | undefined,
): MissingRequiredPreopQuestion[] {
  if (!profile) return []
  const states = new Map((answers ?? []).map(answer => [answer.questionId, answer.state]))
  const stateByKey = new Map(profile.questions.map(row => [row.question.stableKey, states.get(row.questionId)]))
  return profile.questions
    .filter(row => row.enabled && row.required && questionAppliesToMode(row.question.applicability, clinicalMode))
    .filter(row => {
      // A required follow-up only counts while its parent is YES.
      const parentKey = bundledQuestion(row.question.stableKey)?.parentKey
      return !parentKey || stateByKey.get(parentKey) === PreopAnswerState.YES
    })
    .filter(row => {
      const state = states.get(row.questionId)
      return state == null || state === PreopAnswerState.NOT_ASKED
    })
    .map(row => ({
      stableKey: row.question.stableKey,
      labelEn: row.question.labelEn,
      labelBg: row.question.labelBg,
      fields: preopPayloadKeysForQuestion(row.question.stableKey),
    }))
}

function serializeQuestion(row: {
  enabled: boolean
  required: boolean
  sortOrder: number
  question: PreopProfileQuestionRow["question"]
}): PreopProfileShape["questions"][number] {
  const bundled = bundledQuestion(row.question.stableKey)
  return {
    stableKey: row.question.stableKey,
    enabled: row.enabled,
    required: row.required,
    sortOrder: row.sortOrder,
    section: row.question.section,
    formSection: bundled?.formSection ?? "anamnesis",
    parentKey: bundled?.parentKey ?? null,
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
    options: row.question.options.map(option => ({
      key: option.key,
      labelEn: option.labelEn,
      labelBg: option.labelBg,
      omopConceptId: option.omopConceptId,
      omopVocabulary: option.omopVocabulary,
      omopSourceCode: option.omopSourceCode,
    })),
  }
}

export function serializePreopProfile(profile: PreopProfileRow): PreopProfileShape {
  return {
    id: profile.id,
    version: profile.version,
    catalogVersion: profile.catalogVersion,
    status: profile.status,
    publishedAt: profile.publishedAt,
    questions: profile.questions.map(serializeQuestion),
  }
}

/**
 * The profile a fresh appliance starts with, straight from the bundle, for
 * reads that must not write (a case read before any preop was ever saved).
 */
export function defaultPreopProfileShape(): PreopProfileShape {
  return {
    id: "bundled-default",
    version: 0,
    catalogVersion: PREOP_CATALOG_VERSION,
    status: PreopProfileStatus.PUBLISHED,
    publishedAt: null,
    questions: BUNDLED_PREOP_QUESTIONS.map((item, sortOrder) => serializeQuestion({
      enabled: DEFAULT_ENABLED_QUESTION_KEYS.has(item.stableKey),
      required: item.requiredDefault,
      sortOrder,
      question: {
        stableKey: item.stableKey,
        allowUnknown: item.allowUnknown,
        allowNotApplicable: item.allowNotApplicable,
        applicability: item.applicability,
        options: item.options.map(option => ({
          key: option.key,
          labelEn: option.labelEn,
          labelBg: option.labelBg,
          omopConceptId: option.omopConceptId ?? null,
          omopVocabulary: option.omopVocabulary ?? null,
          omopSourceCode: option.omopSourceCode ?? null,
        })),
        labelEn: item.labelEn,
        labelBg: item.labelBg,
        answerType: item.answerType,
        section: item.section,
        conditionalRuleKey: item.conditionalRuleKey ?? null,
        omopDomain: item.omopDomain ?? null,
        omopConceptId: item.omopConceptId ?? null,
        omopSourceCode: item.omopSourceCode ?? null,
      },
    })),
  }
}
