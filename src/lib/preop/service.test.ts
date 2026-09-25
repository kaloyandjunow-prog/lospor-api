import { describe, expect, it, vi } from "vitest"
import { PreopAnswerState, PreopProfileStatus } from "@/generated/prisma/client"
import { BUNDLED_PREOP_QUESTIONS, DEFAULT_ENABLED_QUESTION_KEYS, PREOP_CATALOG_VERSION } from "./catalog"
import {
  ensurePreopProfile,
  legacyAnswers,
  missingRequiredPreopQuestions,
  PreopContractError,
  preopContractBlockedKeys,
  provisionPreopCatalog,
  savePreopAnswers,
  updatePreopProfile,
  type PreopDb,
} from "./service"

type Row = {
  questionId: string
  state: PreopAnswerState
  optionKey: string | null
  valueText: string | null
  valueNumber: number | null
  valueDate: Date | null
  source: string
  provenance: unknown
}

/** The bundled catalogue as a provisioned profile, optionally reconfigured. */
function profileRow(configure: Record<string, { enabled?: boolean; required?: boolean }> = {}) {
  return {
    id: "profile-1",
    version: 1,
    catalogVersion: PREOP_CATALOG_VERSION,
    status: PreopProfileStatus.PUBLISHED,
    publishedAt: new Date("2026-09-24T00:00:00Z"),
    questions: BUNDLED_PREOP_QUESTIONS.map((item, sortOrder) => ({
      questionId: `q-${item.stableKey}`,
      enabled: configure[item.stableKey]?.enabled ?? DEFAULT_ENABLED_QUESTION_KEYS.has(item.stableKey),
      required: configure[item.stableKey]?.required ?? false,
      sortOrder,
      question: {
        stableKey: item.stableKey,
        allowUnknown: item.allowUnknown,
        allowNotApplicable: item.allowNotApplicable,
        applicability: item.applicability,
        options: item.options.map(option => ({
          key: option.key, labelEn: option.labelEn, labelBg: option.labelBg,
          omopConceptId: option.omopConceptId ?? null, omopVocabulary: option.omopVocabulary ?? null, omopSourceCode: option.omopSourceCode ?? null,
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

/** A stand-in for the answer table that behaves like the real one. */
function fakeDb(profile = profileRow()) {
  const answers = new Map<string, Row>()
  const writes: string[] = []
  const db = {
    preopAssessmentProfile: {
      findFirst: vi.fn(async () => profile),
      update: vi.fn(async () => profile),
    },
    preopProfileQuestion: {
      update: vi.fn(async ({ where, data }: { where: { profileId_questionId: { questionId: string } }; data: Record<string, unknown> }) => {
        const row = profile.questions.find(item => item.questionId === where.profileId_questionId.questionId)!
        Object.assign(row, data)
        return row
      }),
    },
    preopAssessmentAuditEvent: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
    preopAssessmentAnswer: {
      findMany: vi.fn(async () => [...answers.values()]),
      upsert: vi.fn(async ({ where, create, update }: { where: { preopId_questionId: { questionId: string } }; create: Row; update: Row }) => {
        const questionId = where.preopId_questionId.questionId
        const row = answers.has(questionId) ? { ...answers.get(questionId)!, ...update } : { ...create, questionId }
        answers.set(questionId, row)
        writes.push(questionId)
        return row
      }),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        for (const row of data) {
          if (answers.has(row.questionId as string)) throw new Error("unique (preopId, questionId)")
          answers.set(row.questionId as string, { ...row })
          writes.push(row.questionId as string)
        }
        return { count: data.length }
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { questionId: { in: string[] } }; data: Row }) => {
        for (const id of where.questionId.in) {
          answers.set(id, { ...answers.get(id)!, ...data })
          writes.push(id)
        }
        return { count: where.questionId.in.length }
      }),
      update: vi.fn(async ({ where, data }: { where: { preopId_questionId: { questionId: string } }; data: Row }) => {
        const questionId = where.preopId_questionId.questionId
        if (!answers.has(questionId)) throw new Error("record to update not found")
        const row = { ...answers.get(questionId)!, ...data }
        answers.set(questionId, row)
        writes.push(questionId)
        return row
      }),
      deleteMany: vi.fn(async ({ where }: { where: { questionId: string | { in: string[] } } }) => {
        const ids = typeof where.questionId === "string" ? [where.questionId] : where.questionId.in
        let count = 0
        for (const id of ids) if (answers.delete(id)) count += 1
        return { count }
      }),
    },
  } as unknown as PreopDb
  const stateOf = (key: string) => answers.get(`q-${key}`)?.state
  const save = (preop: Record<string, unknown>, extra: { answers?: Parameters<typeof savePreopAnswers>[1]["answers"]; clinicalMode?: string } = {}) =>
    savePreopAnswers(db, { caseId: "case-1", preopId: "preop-1", actorId: "clinician-1", preop, ...extra })
  return { db, answers, writes, stateOf, save, profile }
}

const ADULT_BASELINE_ON = BUNDLED_PREOP_QUESTIONS
  .filter(item => DEFAULT_ENABLED_QUESTION_KEYS.has(item.stableKey) && !item.applicability.includes("PEDIATRIC"))

describe("the answer rows record what was asked", () => {
  it("gives every question that is on a row, and every question that is off none", async () => {
    const { save, answers, stateOf } = fakeDb()
    await save({ clinicalMode: "ADULT", smoking: false })

    expect(stateOf("BASE_SMOKING")).toBe(PreopAnswerState.NO)
    expect(stateOf("BASE_LATEX_ALLERGY")).toBe(PreopAnswerState.NOT_ASKED)
    expect(stateOf("A1_RECENT_INFECTION")).toBeUndefined()
    expect(stateOf("BASE_POVOC_HISTORY")).toBeUndefined()
    expect(answers.size).toBe(ADULT_BASELINE_ON.length)
  })

  // Inside a 5-second transaction on a hosted database, one round trip per
  // question is what timed out. A first save is one insert, however many rows.
  it("creates a case's rows in one statement, not one per question", async () => {
    const { save, db } = fakeDb()
    await save({ clinicalMode: "ADULT", smoking: false })
    expect(db.preopAssessmentAnswer.createMany).toHaveBeenCalledOnce()
    expect(db.preopAssessmentAnswer.update).not.toHaveBeenCalled()
    expect(db.preopAssessmentAnswer.upsert).not.toHaveBeenCalled()
  })

  it("keeps stored answers when a partial autosave does not mention them", async () => {
    const { save, stateOf, writes } = fakeDb()
    await save({ clinicalMode: "ADULT", smoking: true })
    writes.length = 0
    await save({ clinicalMode: "ADULT", heightCm: 216 })

    expect(stateOf("BASE_SMOKING")).toBe(PreopAnswerState.YES)
    expect(writes).toEqual([])
  })

  it("resets an answer the clinician set back to unanswered", async () => {
    const { save, stateOf } = fakeDb()
    await save({ clinicalMode: "ADULT", smoking: true })
    await save({ clinicalMode: "ADULT", smoking: null })

    expect(stateOf("BASE_SMOKING")).toBe(PreopAnswerState.NOT_ASKED)
  })

  it("does not rewrite an answer that has not changed", async () => {
    const { save, writes, answers } = fakeDb()
    await save({ clinicalMode: "ADULT", smoking: true })
    answers.get("q-BASE_SMOKING")!.source = "suggestion"
    writes.length = 0
    await save({ clinicalMode: "ADULT", smoking: true })

    expect(writes).toEqual([])
    expect(answers.get("q-BASE_SMOKING")!.source).toBe("suggestion")
  })

  it("treats a false COLDS applicability as no answer: false means nobody looked", () => {
    expect(legacyAnswers({ coldsApplicable: false })).toEqual([])
    expect(legacyAnswers({ coldsApplicable: true })).toEqual([{ stableKey: "BASE_COLDS_APPLICABLE", state: PreopAnswerState.YES }])
  })
})

describe("switching a question on or off", () => {
  it("creates the row for a question switched on mid-case at the next save", async () => {
    const env = fakeDb()
    await env.save({ clinicalMode: "ADULT" })
    expect(env.stateOf("A12_PACEMAKER_ICD")).toBeUndefined()

    env.profile.questions.find(row => row.question.stableKey === "A12_PACEMAKER_ICD")!.enabled = true
    await env.save({ clinicalMode: "ADULT" })
    expect(env.stateOf("A12_PACEMAKER_ICD")).toBe(PreopAnswerState.NOT_ASKED)
  })

  it("removes an unanswered row when the question is switched off, and keeps a real answer", async () => {
    const env = fakeDb(profileRow({ A12_PACEMAKER_ICD: { enabled: true }, A5_FALLS_LAST_12_MONTHS: { enabled: true } }))
    await env.save({ clinicalMode: "ADULT" }, { answers: [{ stableKey: "A12_PACEMAKER_ICD", state: PreopAnswerState.YES, optionKey: "YES" }] })

    for (const key of ["A12_PACEMAKER_ICD", "A5_FALLS_LAST_12_MONTHS"]) {
      env.profile.questions.find(row => row.question.stableKey === key)!.enabled = false
    }
    await env.save({ clinicalMode: "ADULT" })

    expect(env.stateOf("A12_PACEMAKER_ICD")).toBe(PreopAnswerState.YES)
    expect(env.stateOf("A5_FALLS_LAST_12_MONTHS")).toBeUndefined()
  })

  it("stores an answer that arrives after its question was switched off, and says so", async () => {
    const env = fakeDb()
    await env.save({ clinicalMode: "ADULT" }, { answers: [{ stableKey: "A12_PACEMAKER_ICD", state: PreopAnswerState.NO, optionKey: "NO" }] })

    expect(env.stateOf("A12_PACEMAKER_ICD")).toBe(PreopAnswerState.NO)
    expect(env.answers.get("q-A12_PACEMAKER_ICD")!.provenance).toEqual({ source: "clinician", recordedWhileQuestionOff: true })
  })

  it("does not turn a hidden baseline toggle into a row when the question is off", async () => {
    const env = fakeDb(profileRow({ BASE_SMOKING: { enabled: false } }))
    await env.save({ clinicalMode: "ADULT", smoking: false })

    expect(env.stateOf("BASE_SMOKING")).toBeUndefined()
  })

  it("asks a pediatric case none of the adult questions, and drops them if the case changes population", async () => {
    const env = fakeDb(profileRow({ A12_PACEMAKER_ICD: { enabled: true }, P8_DIFFICULT_VENOUS_ACCESS: { enabled: true } }))
    await env.save({ clinicalMode: "ADULT" }, { answers: [{ stableKey: "A12_PACEMAKER_ICD", state: PreopAnswerState.YES, optionKey: "YES" }] })
    await env.save({ clinicalMode: "PEDIATRIC" })

    expect(env.stateOf("A12_PACEMAKER_ICD")).toBeUndefined()
    expect(env.stateOf("P8_DIFFICULT_VENOUS_ACCESS")).toBe(PreopAnswerState.NOT_ASKED)
    expect(env.stateOf("BASE_POVOC_HISTORY")).toBe(PreopAnswerState.NOT_ASKED)
  })
})

describe("preopAnswers is the complete set of the form", () => {
  it("clears an addition the form no longer holds", async () => {
    const env = fakeDb(profileRow({ A12_PACEMAKER_ICD: { enabled: true } }))
    await env.save({ clinicalMode: "ADULT" }, { answers: [{ stableKey: "A12_PACEMAKER_ICD", state: PreopAnswerState.YES, optionKey: "YES" }] })
    await env.save({ clinicalMode: "ADULT" }, { answers: [] })
    expect(env.stateOf("A12_PACEMAKER_ICD")).toBe(PreopAnswerState.NOT_ASKED)
  })

  it("leaves additions alone when preopAnswers is not sent", async () => {
    const env = fakeDb(profileRow({ A12_PACEMAKER_ICD: { enabled: true } }))
    await env.save({ clinicalMode: "ADULT" }, { answers: [{ stableKey: "A12_PACEMAKER_ICD", state: PreopAnswerState.YES, optionKey: "YES" }] })
    await env.save({ clinicalMode: "ADULT", heightCm: 180 })
    expect(env.stateOf("A12_PACEMAKER_ICD")).toBe(PreopAnswerState.YES)
  })

  it("answers baseline questions through their own field only, never from a stale copy", async () => {
    const env = fakeDb()
    await env.save({ clinicalMode: "ADULT", smoking: true }, { answers: [{ stableKey: "BASE_SMOKING", state: PreopAnswerState.NO, optionKey: "NO" }] })
    expect(env.stateOf("BASE_SMOKING")).toBe(PreopAnswerState.YES)
  })
})

describe("follow-up questions", () => {
  const withA1 = () => fakeDb(profileRow({ A1_RECENT_INFECTION: { enabled: true }, A1_RECENT_INFECTION_TWO_WEEKS: { enabled: true } }))

  it("keeps a follow-up only while its parent is YES", async () => {
    const env = withA1()
    await env.save({ clinicalMode: "ADULT" }, { answers: [
      { stableKey: "A1_RECENT_INFECTION", state: PreopAnswerState.YES, optionKey: "YES" },
      { stableKey: "A1_RECENT_INFECTION_TWO_WEEKS", state: PreopAnswerState.YES, optionKey: "YES" },
    ] })
    expect(env.stateOf("A1_RECENT_INFECTION_TWO_WEEKS")).toBe(PreopAnswerState.YES)

    await env.save({ clinicalMode: "ADULT" }, { answers: [{ stableKey: "A1_RECENT_INFECTION", state: PreopAnswerState.NO, optionKey: "NO" }] })
    expect(env.stateOf("A1_RECENT_INFECTION_TWO_WEEKS")).toBe(PreopAnswerState.NOT_ASKED)
  })

  it("does not store a follow-up answered while the parent is not YES", async () => {
    const env = withA1()
    await env.save({ clinicalMode: "ADULT" }, { answers: [{ stableKey: "A1_RECENT_INFECTION_TWO_WEEKS", state: PreopAnswerState.YES, optionKey: "YES" }] })
    expect(env.stateOf("A1_RECENT_INFECTION_TWO_WEEKS")).toBe(PreopAnswerState.NOT_ASKED)
  })
})

describe("answer validation", () => {
  it("refuses a client-sent NOT_ASKED, an unknown question, and an option the question does not have", async () => {
    const env = fakeDb()
    await expect(env.save({}, { answers: [{ stableKey: "A12_PACEMAKER_ICD", state: PreopAnswerState.NOT_ASKED }] }))
      .rejects.toMatchObject({ code: "NOT_ASKED_IS_SERVER_GENERATED" })
    await expect(env.save({}, { answers: [{ stableKey: "NOT_IN_CATALOGUE", state: PreopAnswerState.YES }] }))
      .rejects.toMatchObject({ code: "UNKNOWN_PREOP_QUESTION" })
    await expect(env.save({}, { answers: [{ stableKey: "A12_PACEMAKER_ICD", state: PreopAnswerState.YES, optionKey: "MAYBE" }] }))
      .rejects.toMatchObject({ code: "UNKNOWN_PREOP_ANSWER_OPTION" })
  })

  it("names the form fields a refusal blocks, and none for a server fault", () => {
    expect(preopContractBlockedKeys(new PreopContractError("UNKNOWN_NOT_ALLOWED", { stableKey: "BASE_SMOKING" }))).toEqual(["smoking"])
    expect(preopContractBlockedKeys(new PreopContractError("UNKNOWN_PREOP_ANSWER_OPTION", { stableKey: "A13_PREGNANCY" }))).toEqual(["preopAnswers"])
    expect(preopContractBlockedKeys(new PreopContractError("MUTUALLY_EXCLUSIVE_SURGERY_URGENCY"))).toEqual(["elective", "emergencySurgery"])
    expect(preopContractBlockedKeys(new PreopContractError("PREOP_PROFILE_NOT_PROVISIONED"))).toBeNull()
  })
})

describe("required questions gate continue-to-intraop, never a save", () => {
  it("lists required questions that are on for the case and unanswered", () => {
    const profile = profileRow({
      BASE_SMOKING: { required: true },
      BASE_POVOC_HISTORY: { required: true },
      A1_RECENT_INFECTION: { enabled: true },
      A1_RECENT_INFECTION_TWO_WEEKS: { enabled: true, required: true },
    })
    const missing = (answers: Array<{ questionId: string; state: string }>) =>
      missingRequiredPreopQuestions(profile, answers, "ADULT").map(item => item.stableKey)

    expect(missing([])).toEqual(["BASE_SMOKING"])
    expect(missing([{ questionId: "q-BASE_SMOKING", state: "NO" }])).toEqual([])
    expect(missing([
      { questionId: "q-BASE_SMOKING", state: "NO" },
      { questionId: "q-A1_RECENT_INFECTION", state: "YES" },
    ])).toEqual(["A1_RECENT_INFECTION_TWO_WEEKS"])
  })

  it("saves a draft with a required question unanswered", async () => {
    const env = fakeDb(profileRow({ BASE_SMOKING: { required: true } }))
    await expect(env.save({ clinicalMode: "ADULT", heightCm: 180 })).resolves.toBeDefined()
  })
})

describe("the one profile", () => {
  const all = (profile: ReturnType<typeof profileRow>) => profile.questions.map(row => ({
    stableKey: row.question.stableKey, enabled: row.enabled, required: row.required, sortOrder: row.sortOrder,
  }))

  it("is changed in place, and only what changed is audited", async () => {
    const env = fakeDb()
    const requested = all(env.profile).map(item => item.stableKey === "A12_PACEMAKER_ICD" ? { ...item, enabled: true, required: true } : item)
    await updatePreopProfile(env.db, "admin-1", requested, "Ask about implanted cardiac devices")

    expect(env.profile.questions.find(row => row.question.stableKey === "A12_PACEMAKER_ICD")).toMatchObject({ enabled: true, required: true })
    const audit = vi.mocked(env.db.preopAssessmentAuditEvent.create).mock.calls[0]![0] as { data: { action: string; detail: { changes: unknown[] } } }
    expect(audit.data.action).toBe("PROFILE_UPDATED")
    expect(audit.data.detail.changes).toHaveLength(1)
  })

  it("refuses an incomplete list, a duplicate order and a required question that is off", async () => {
    const env = fakeDb()
    const requested = all(env.profile)
    await expect(updatePreopProfile(env.db, "admin-1", requested.slice(1), "reason text"))
      .rejects.toMatchObject({ code: "PREOP_PROFILE_CATALOG_INCOMPLETE" })
    await expect(updatePreopProfile(env.db, "admin-1", requested.map((item, index) => index === 1 ? { ...item, sortOrder: 0 } : item), "reason text"))
      .rejects.toMatchObject({ code: "DUPLICATE_PREOP_QUESTION_ORDER" })
    await expect(updatePreopProfile(env.db, "admin-1", requested.map((item, index) => index === 0 ? { ...item, enabled: false, required: true } : item), "reason text"))
      .rejects.toMatchObject({ code: "DISABLED_QUESTION_CANNOT_BE_REQUIRED" })
  })

  it("is created with only the baseline switched on, in flat writes", async () => {
    let active: unknown = null
    const createMany = vi.fn(async () => {
      active = profileRow()
      return { count: BUNDLED_PREOP_QUESTIONS.length }
    })
    const create = vi.fn(async () => ({ id: "profile-new" }))
    const db = {
      $executeRaw: vi.fn(async () => 0),
      preopQuestionDefinition: {
        findMany: vi.fn(async ({ select }: { select?: { id?: boolean } } = {}) =>
          select && "id" in select ? BUNDLED_PREOP_QUESTIONS.map(item => ({ id: "definition-" + item.stableKey, stableKey: item.stableKey })) : []),
      },
      preopAssessmentProfile: {
        findFirst: vi.fn(async ({ select }: { select?: unknown } = {}) => select ? null : active),
        create,
      },
      preopProfileQuestion: { createMany },
      preopAssessmentAuditEvent: { create: vi.fn() },
    } as unknown as PreopDb

    await ensurePreopProfile(db, "clinician-1")

    // No nested create: that resolved each question with its own queries.
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ questions: expect.anything() }) }))
    expect(createMany).toHaveBeenCalledOnce()
    const rows = (createMany.mock.calls[0] as unknown as [{ data: Array<{ questionId: string; enabled: boolean; profileId: string }> }])[0].data
    expect(rows).toHaveLength(BUNDLED_PREOP_QUESTIONS.length)
    expect(rows.every(row => row.profileId === "profile-new")).toBe(true)
    const enabled = rows.filter(row => row.enabled).map(row => row.questionId.replace("definition-", ""))
    expect(enabled.length).toBe(30)
    expect(enabled.every(key => key.startsWith("BASE_"))).toBe(true)
  })

  it("adds a release's new questions switched off, after the operator's order", async () => {
    const profile = profileRow()
    const dropped = profile.questions.pop()!
    profile.catalogVersion = "1.4.7"
    const createMany = vi.fn(async () => ({ count: 1 }))
    const db = {
      $executeRaw: vi.fn(async () => 0),
      preopQuestionDefinition: {
        findMany: vi.fn(async ({ where }: { where?: { stableKey?: { in: string[] } } } = {}) =>
          where ? where.stableKey!.in.map(stableKey => ({ id: "definition-" + stableKey, stableKey })) : []),
      },
      preopAssessmentProfile: { findFirst: vi.fn(async () => profile), update: vi.fn(async () => profile) },
      preopProfileQuestion: { createMany },
      preopAssessmentAuditEvent: { create: vi.fn() },
    } as unknown as PreopDb

    await ensurePreopProfile(db, "clinician-1")

    expect(createMany).toHaveBeenCalledOnce()
    expect(createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({
      questionId: "definition-" + dropped.question.stableKey,
      enabled: false,
      required: false,
      sortOrder: profile.questions.length,
    })] })
  })
})

describe("the catalogue", () => {
  // An upgrade runs inside a clinician's save. Row by row it took about 300
  // round trips and outlived the 5-second transaction on a hosted database, so
  // the save failed and the upgrade never finished. It must stay a fixed, small
  // number of statements however large the catalogue is.
  it("is brought up to the bundle in one read and two statements, whatever changed", async () => {
    const executeRaw = vi.fn(async () => 0)
    const findMany = vi.fn(async () => [])
    const db = { $executeRaw: executeRaw, preopQuestionDefinition: { findMany } } as unknown as PreopDb

    await provisionPreopCatalog(db)

    expect(findMany).toHaveBeenCalledOnce()
    expect(executeRaw).toHaveBeenCalledTimes(2)
    const [questions, options] = executeRaw.mock.calls.map(call => String((call as unknown[])[0]))
    expect(questions).toContain("INSERT INTO \"PreopQuestionDefinition\"")
    expect(questions).toContain("ON CONFLICT (\"stableKey\") DO UPDATE")
    // Options are added or updated, never deleted: an answer may reference one.
    expect(options).toContain("INSERT INTO \"PreopAnswerOption\"")
    expect(options).toContain("ON CONFLICT (\"questionId\", \"key\") DO UPDATE")
    expect(options).not.toContain("DELETE")
  })

  it("writes nothing when the stored catalogue already matches the bundle", async () => {
    const executeRaw = vi.fn(async () => 0)
    const stored = BUNDLED_PREOP_QUESTIONS.map(item => ({
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
      options: item.options.map((option, sortOrder) => ({
        key: option.key,
        labelEn: option.labelEn,
        labelBg: option.labelBg,
        omopConceptId: option.omopConceptId ?? null,
        omopVocabulary: option.omopVocabulary ?? null,
        omopSourceCode: option.omopSourceCode ?? null,
        sortOrder,
      })),
    }))
    const db = { $executeRaw: executeRaw, preopQuestionDefinition: { findMany: vi.fn(async () => stored) } } as unknown as PreopDb

    await provisionPreopCatalog(db)
    expect(executeRaw).not.toHaveBeenCalled()

    stored[0]!.catalogVersion = "1.4.7"
    await provisionPreopCatalog(db)
    expect(executeRaw).toHaveBeenCalledTimes(2)
  })

  it("maps every question to OMOP and places every question in a form section", () => {
    for (const item of BUNDLED_PREOP_QUESTIONS) {
      expect(item.omopSourceCode, item.stableKey).toMatch(/^LOSPOR:/)
      expect(typeof item.omopConceptId, item.stableKey).toBe("number")
      expect(item.formSection, item.stableKey).toBeTruthy()
    }
    const a1FollowUp = BUNDLED_PREOP_QUESTIONS.find(item => item.stableKey === "A1_RECENT_INFECTION_TWO_WEEKS")!
    expect(a1FollowUp.parentKey).toBe("A1_RECENT_INFECTION")
  })
})
