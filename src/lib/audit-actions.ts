/**
 * Stable, public action codes for the durable audit trail.
 *
 * This is deliberately the single registry for both persistence and display:
 * the administrator audit endpoint returns these definitions and first-party
 * clients render the supplied Bulgarian/English labels. A new persisted action
 * therefore cannot silently disappear from a hand-maintained client filter.
 *
 * Codes are append-only compatibility identifiers. Change a label when copy
 * improves; never rename or recycle a code that may already exist in a log.
 */
export type AuditActionCategory =
  | "ACCOUNT"
  | "AUTHENTICATION"
  | "CASE"
  | "CLINICAL_RULES"
  | "INSTITUTION"
  | "MAINTENANCE"
  | "RESEARCH"
  | "SECURITY"

export type AuditActionDefinition = {
  code: string
  category: AuditActionCategory
  labels: Readonly<{ bg: string; en: string }>
}

function defineAuditActions<const T extends readonly AuditActionDefinition[]>(actions: T): T {
  return actions
}

export const AUDIT_ACTION_REGISTRY = defineAuditActions([
  { code: "ACCOUNT_PROVISION", category: "ACCOUNT", labels: { bg: "Създаден профил", en: "Account created" } },
  { code: "ACCOUNT_ACTIVATE", category: "ACCOUNT", labels: { bg: "Активиран профил", en: "Account activated" } },
  { code: "ACCOUNT_ACTIVATION_TOKEN_REISSUE", category: "AUTHENTICATION", labels: { bg: "Издадена нова връзка за активиране", en: "Activation link reissued" } },
  { code: "ACCOUNT_DELETE_REQUEST", category: "ACCOUNT", labels: { bg: "Заявено изтриване на профил", en: "Account deletion requested" } },
  { code: "ACCOUNT_ANONYMISED", category: "ACCOUNT", labels: { bg: "Анонимизиран профил", en: "Account anonymised" } },
  { code: "ADMIN_ACCOUNT_AUTHORITY_CHANGE", category: "ACCOUNT", labels: { bg: "Променени права на профил", en: "Account authority changed" } },
  { code: "ADMIN_ACCOUNT_PROMOTE", category: "ACCOUNT", labels: { bg: "Повишен до администратор", en: "Promoted to administrator" } },
  { code: "ADMIN_ACCOUNT_DEMOTE", category: "ACCOUNT", labels: { bg: "Понижен от администратор", en: "Demoted from administrator" } },
  { code: "ADMIN_ACCOUNT_SUSPEND", category: "ACCOUNT", labels: { bg: "Спрян профил", en: "Account suspended" } },
  { code: "ADMIN_ACCOUNT_REACTIVATE", category: "ACCOUNT", labels: { bg: "Възстановен спрян профил", en: "Suspended account reactivated" } },
  { code: "ADMIN_ACCOUNT_DELETE", category: "ACCOUNT", labels: { bg: "Профилът е поставен за изтриване", en: "Account scheduled for deletion" } },
  { code: "ADMIN_ACCOUNT_RESTORE", category: "ACCOUNT", labels: { bg: "Възстановен профил за възстановяване на достъпа", en: "Account restored for recovery" } },
  { code: "PROFILE_CORRECTION", category: "ACCOUNT", labels: { bg: "Коригиран профил", en: "Profile corrected" } },
  { code: "ROLE_REQUEST_SUBMIT", category: "ACCOUNT", labels: { bg: "Подадена заявка за роля", en: "Role request submitted" } },
  { code: "HOD_ROLE_REQUEST_APPROVE", category: "ACCOUNT", labels: { bg: "Одобрена заявка за началник отделение", en: "Head-of-department request approved" } },
  { code: "HOD_ROLE_REQUEST_REJECT", category: "ACCOUNT", labels: { bg: "Отказана заявка за началник отделение", en: "Head-of-department request rejected" } },
  { code: "LEGAL_ACCEPTANCE_RECORD", category: "ACCOUNT", labels: { bg: "Приети правни документи", en: "Legal documents accepted" } },

  { code: "PASSWORD_CHANGE", category: "AUTHENTICATION", labels: { bg: "Променена парола", en: "Password changed" } },
  { code: "PASSWORD_RECOVERY", category: "AUTHENTICATION", labels: { bg: "Възстановена парола", en: "Password recovered" } },
  { code: "PASSWORD_RECOVERY_TOKEN_ISSUE", category: "AUTHENTICATION", labels: { bg: "Издадена връзка за възстановяване на парола", en: "Password recovery link issued" } },
  { code: "SESSION_REVOKE", category: "AUTHENTICATION", labels: { bg: "Прекратена сесия", en: "Session revoked" } },
  { code: "SESSION_REVOKE_OTHERS", category: "AUTHENTICATION", labels: { bg: "Прекратени други сесии", en: "Other sessions revoked" } },
  { code: "ADMIN_MFA_ENROLL", category: "AUTHENTICATION", labels: { bg: "Включена двустъпкова проверка на администратор", en: "Administrator two-step verification enrolled" } },
  { code: "ADMIN_MFA_RECOVERY_CODE_USE", category: "AUTHENTICATION", labels: { bg: "Използван код за възстановяване на администратор", en: "Administrator recovery code used" } },

  { code: "INSTITUTION_CHANGE_REQUEST_SUBMIT", category: "INSTITUTION", labels: { bg: "Подадена заявка за смяна на лечебно заведение", en: "Institution change requested" } },
  { code: "INSTITUTION_CHANGE_APPROVE", category: "INSTITUTION", labels: { bg: "Одобрена смяна на лечебно заведение", en: "Institution change approved" } },
  { code: "INSTITUTION_CHANGE_REJECT", category: "INSTITUTION", labels: { bg: "Отказана смяна на лечебно заведение", en: "Institution change rejected" } },
  { code: "INSTITUTION_CHANGE_SELF_LEAVE", category: "INSTITUTION", labels: { bg: "Напуснато лечебно заведение", en: "Institution left" } },

  { code: "CLINICAL_RULESET_CREATE", category: "CLINICAL_RULES", labels: { bg: "Създаден набор от клинични правила", en: "Clinical ruleset created" } },
  { code: "CLINICAL_RULESET_RULE_UPSERT", category: "CLINICAL_RULES", labels: { bg: "Запазено клинично правило", en: "Clinical rule saved" } },
  { code: "CLINICAL_RULESET_RULE_DELETE", category: "CLINICAL_RULES", labels: { bg: "Изтрито клинично правило", en: "Clinical rule deleted" } },
  { code: "CLINICAL_RULESET_PEDIATRIC_DRUG_REPLACE", category: "CLINICAL_RULES", labels: { bg: "Заменени педиатрични лекарствени профили", en: "Pediatric medication profiles replaced" } },
  { code: "CLINICAL_RULESET_PUBLISH", category: "CLINICAL_RULES", labels: { bg: "Публикуван набор от клинични правила", en: "Clinical ruleset published" } },
  { code: "CLINICAL_RULESET_SELECT", category: "CLINICAL_RULES", labels: { bg: "Избран набор от клинични правила", en: "Clinical ruleset selected" } },
  { code: "CLINICAL_RULESET_SELECTION_CLEAR", category: "CLINICAL_RULES", labels: { bg: "Премахнат избор на клинични правила", en: "Clinical ruleset selection cleared" } },
  { code: "CLINICAL_RULESET_PUBLISH_AND_SELECT", category: "CLINICAL_RULES", labels: { bg: "Публикуван и избран набор от клинични правила", en: "Clinical ruleset published and selected" } },
  { code: "CLINICAL_RULESET_DEV_RESET", category: "CLINICAL_RULES", labels: { bg: "Нулирани клинични правила за разработка", en: "Development clinical rules reset" } },
  { code: "CLINICAL_RULESET_E2E_PROVISION", category: "CLINICAL_RULES", labels: { bg: "Подготвени клинични правила за E2E тест", en: "E2E clinical rules provisioned" } },
  { code: "CLINICAL_RULESET_PRUNE", category: "CLINICAL_RULES", labels: { bg: "Премахнат надживян набор от клинични правила", en: "Superseded clinical ruleset removed" } },
  { code: "CLINICAL_BUNDLED_BASELINE_PROVISION", category: "CLINICAL_RULES", labels: { bg: "Инсталиран базов набор от клинични правила", en: "Bundled clinical baseline installed" } },

  { code: "CASE_CREATE", category: "CASE", labels: { bg: "Създаден случай", en: "Case created" } },
  { code: "CASE_UPDATE", category: "CASE", labels: { bg: "Обновен случай", en: "Case updated" } },
  { code: "CASE_DELETE", category: "CASE", labels: { bg: "Изтрит случай", en: "Case deleted" } },
  { code: "CASE_FINALIZED", category: "CASE", labels: { bg: "Финализиран случай", en: "Case finalised" } },
  { code: "CASE_UNFINALIZED", category: "CASE", labels: { bg: "Отменено финализиране на случай", en: "Case finalisation reversed" } },
  { code: "CASE_CONFLICT_OVERRIDE", category: "CASE", labels: { bg: "Преодолян конфликт при запис", en: "Save conflict overridden" } },
  { code: "CASE_EVENT_ADD", category: "CASE", labels: { bg: "Добавено събитие към случай", en: "Case event added" } },
  { code: "CASE_EVENT_EDIT", category: "CASE", labels: { bg: "Редактирано събитие в случай", en: "Case event edited" } },
  { code: "CASE_EVENT_DELETE", category: "CASE", labels: { bg: "Изтрито събитие от случай", en: "Case event deleted" } },
  { code: "CASE_TRANSFER_REQUEST", category: "CASE", labels: { bg: "Заявено предаване на случай", en: "Case handover requested" } },
  { code: "CASE_TRANSFER_ACCEPT", category: "CASE", labels: { bg: "Прието предаване на случай", en: "Case handover accepted" } },
  { code: "CASE_TRANSFER_DECLINE", category: "CASE", labels: { bg: "Отказано предаване на случай", en: "Case handover declined" } },
  { code: "CASE_TRANSFER_CANCEL", category: "CASE", labels: { bg: "Оттеглено предаване на случай", en: "Case handover withdrawn" } },
  { code: "CASE_TRANSFER_ASSIGN", category: "CASE", labels: { bg: "Преназначен случай", en: "Case reassigned" } },
  { code: "INTRAOP_TIME_ANOMALY_REPAIRED", category: "CASE", labels: { bg: "Коригирана времева аномалия в интраоперативно събитие", en: "Intraoperative event time anomaly repaired" } },
  { code: "RELATIONAL_SYNC_FAILED", category: "CASE", labels: { bg: "Неуспешна синхронизация на данните за случай", en: "Case data synchronisation failed" } },

  { code: "AI_ADVISE", category: "SECURITY", labels: { bg: "Използван съвет от ИИ", en: "AI advice used" } },
  { code: "PII_BLOCKED", category: "SECURITY", labels: { bg: "Блокирани лични данни", en: "Personal data blocked" } },

  { code: "RESEARCH_SELF_AUTHORIZE", category: "RESEARCH", labels: { bg: "Самооторизиран изследователски достъп", en: "Research access self-authorised" } },
  { code: "RESEARCH_GRANT_CREATE", category: "RESEARCH", labels: { bg: "Създадено разрешение за изследователски достъп", en: "Research access grant created" } },
  { code: "RESEARCH_GRANT_UPDATE", category: "RESEARCH", labels: { bg: "Променено разрешение за изследователски достъп", en: "Research access grant changed" } },
  { code: "RESEARCH_GRANT_REVOKE", category: "RESEARCH", labels: { bg: "Отнето разрешение за изследователски достъп", en: "Research access grant revoked" } },
  { code: "RESEARCH_QUERY", category: "RESEARCH", labels: { bg: "Изпълнена изследователска заявка", en: "Research query run" } },
  { code: "RESEARCH_CASE_QUERY", category: "RESEARCH", labels: { bg: "Изпълнена заявка за изследователски случаи", en: "Research case query run" } },
  { code: "RESEARCH_CASE_VIEW", category: "RESEARCH", labels: { bg: "Прегледан изследователски случай", en: "Research case viewed" } },
  { code: "RESEARCH_COMPARE", category: "RESEARCH", labels: { bg: "Сравнени изследователски кохорти", en: "Research cohorts compared" } },
  { code: "RESEARCH_BENCHMARK", category: "RESEARCH", labels: { bg: "Изчислен изследователски показател", en: "Research benchmark calculated" } },
  { code: "RESEARCH_COHORT_CREATE", category: "RESEARCH", labels: { bg: "Създадена изследователска кохорта", en: "Research cohort created" } },
  { code: "RESEARCH_COHORT_UPDATE", category: "RESEARCH", labels: { bg: "Обновена изследователска кохорта", en: "Research cohort updated" } },
  { code: "RESEARCH_COHORT_DELETE", category: "RESEARCH", labels: { bg: "Изтрита изследователска кохорта", en: "Research cohort deleted" } },
  { code: "RESEARCH_EXPORT_CREATE", category: "RESEARCH", labels: { bg: "Създаден изследователски експорт", en: "Research export created" } },
  { code: "RESEARCH_EXPORT_DOWNLOAD", category: "RESEARCH", labels: { bg: "Изтеглен изследователски експорт", en: "Research export downloaded" } },

  { code: "maintenance.seed_option_library.blocked", category: "MAINTENANCE", labels: { bg: "Блокирано обновяване на библиотеката с опции", en: "Option-library refresh blocked" } },
  { code: "maintenance.seed_option_library.success", category: "MAINTENANCE", labels: { bg: "Обновена библиотека с опции", en: "Option library refreshed" } },
  { code: "maintenance.seed_option_library.error", category: "MAINTENANCE", labels: { bg: "Неуспешно обновяване на библиотеката с опции", en: "Option-library refresh failed" } },
] as const)

export type AuditActionCode = (typeof AUDIT_ACTION_REGISTRY)[number]["code"]

const ACTION_CODE_SET: ReadonlySet<string> = new Set(
  AUDIT_ACTION_REGISTRY.map(action => action.code),
)

export function isAuditActionCode(value: string): value is AuditActionCode {
  return ACTION_CODE_SET.has(value)
}
