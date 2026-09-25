/**
 * The hospital's compact, immutable preoperative catalog.
 *
 * This is deliberately a software-owned definition, not an Athena dump and
 * not a second list maintained by the web or PWA. The provisioning service
 * persists this exact contract in relational tables and refuses to mutate an
 * existing bundled row with different clinical metadata.
 */

/** The catalogue ships with, and is versioned as, the Hospital release. */
export const PREOP_CATALOG_VERSION = "1.4.8"
export const YES_CONCEPT_ID = 4188539
export const NO_CONCEPT_ID = 4188540
export const A3_WEIGHT_LOSS_CONCEPT_ID = 40491502

export type PreopAnswerType = "BOOLEAN" | "CHOICE" | "NUMBER" | "TEXT" | "DATE"
export type PreopCatalogOption = {
  key: string
  labelEn: string
  labelBg: string
  omopConceptId?: number
  omopVocabulary?: string
  omopSourceCode?: string
}

/** Core canonical preoperative sections; each client maps them onto its own tabs. */
export type PreopFormSection =
  | "demographics"
  | "case_details"
  | "medical_history"
  | "current_medications"
  | "anamnesis"
  | "physical_exam"
  | "airway"
  | "labs"
  | "risk_scores"

export type PreopCatalogQuestion = {
  stableKey: string
  catalogVersion: string
  section: string
  applicability: string[]
  answerType: PreopAnswerType
  labelEn: string
  labelBg: string
  requiredDefault: boolean
  allowUnknown: boolean
  allowNotApplicable: boolean
  conditionalRuleKey?: string
  /** Follow-up questions: the question whose YES shows this one. Derived from conditionalRuleKey. */
  parentKey?: string
  /** The preoperative form section (core canonical key) the question renders in. */
  formSection: PreopFormSection
  omopDomain?: string
  omopConceptId?: number
  omopVocabulary?: string
  omopSourceCode?: string
  options: PreopCatalogOption[]
}

const yesNo = (): PreopCatalogOption[] => [
  { key: "YES", labelEn: "Yes", labelBg: "Да", omopConceptId: YES_CONCEPT_ID, omopVocabulary: "SNOMED" },
  { key: "NO", labelEn: "No", labelBg: "Не", omopConceptId: NO_CONCEPT_ID, omopVocabulary: "SNOMED" },
]

function question(
  stableKey: string,
  section: string,
  labelEn: string,
  labelBg: string,
  options: PreopCatalogOption[] = yesNo(),
  extra: Partial<Omit<PreopCatalogQuestion, "stableKey" | "section" | "labelEn" | "labelBg" | "options" | "formSection">> = {},
): Omit<PreopCatalogQuestion, "formSection"> {
  const resolvedOptions = options.length === 0 && extra.answerType !== "TEXT" ? yesNo() : options
  return {
    stableKey,
    catalogVersion: PREOP_CATALOG_VERSION,
    section,
    applicability: [],
    answerType: "CHOICE",
    labelEn,
    labelBg,
    requiredDefault: false,
    allowUnknown: false,
    allowNotApplicable: false,
    ...extra,
    options: resolvedOptions,
  }
}

const baseline = [
  question("BASE_ALLERGIES", "SAFETY", "Drug or other allergy", "Алергия към лекарство или друго вещество"),
  question("BASE_LATEX_ALLERGY", "SAFETY", "Latex allergy", "Алергия към латекс"),
  question("BASE_FAMILY_ANAESTHESIA_PROBLEMS", "SAFETY", "Family anaesthesia problems", "Проблеми с анестезията в семейството"),
  question("BASE_UNEXPLAINED_ANAESTHESIA_COMPLICATIONS", "SAFETY", "Unexplainable complications during anaesthesia", "Необясними усложнения по време на анестезия"),
  question("BASE_MALIGNANT_HYPERTHERMIA_HISTORY", "SAFETY", "Personal malignant hyperthermia history", "Лична анамнеза за малигнена хипертермия"),
  question("BASE_ANTICIPATED_DIFFICULT_AIRWAY", "AIRWAY", "Anticipated difficult airway", "Очакван труден дихателен път"),
  question("BASE_DENTAL_PROSTHETICS", "AIRWAY", "Dental prosthetics", "Зъбни протези"),
  question("BASE_LOOSE_TEETH", "AIRWAY", "Loose teeth", "Клатещи се зъби"),
  question("BASE_SMOKING", "HISTORY", "Smoking", "Тютюнопушене"),
  question("BASE_SUBSTANCE_ABUSE", "HISTORY", "Substance abuse", "Злоупотреба с психоактивни вещества"),
  question("BASE_HEART_ARRHYTHMIA", "CARDIOVASCULAR", "Heart arrhythmia", "Сърдечна аритмия"),
  question("BASE_RCRI_ISCHEMIC_HEART", "RISK", "Ischaemic heart disease", "Исхемична болест на сърцето"),
  question("BASE_RCRI_CHF", "RISK", "Congestive heart failure", "Застойна сърдечна недостатъчност"),
  question("BASE_RCRI_CVD", "RISK", "Cerebrovascular disease", "Мозъчносъдова болест"),
  question("BASE_RCRI_INSULIN_DM", "RISK", "Insulin-treated diabetes", "Захарен диабет на инсулиново лечение"),
  question("BASE_RCRI_CREATININE", "RISK", "Raised creatinine", "Повишен креатинин"),
  question("BASE_APFEL_PONV_HISTORY", "RISK", "Previous postoperative nausea or vomiting", "Предишно следоперативно гадене или повръщане"),
  question("BASE_APFEL_POSTOP_OPIOIDS", "RISK", "Postoperative opioids planned", "Планирани следоперативни опиоиди"),
  question("BASE_STOPBANG_SNORING", "RISK", "Snoring", "Хъркане"),
  question("BASE_STOPBANG_TIRED", "RISK", "Daytime tiredness", "Дневна сънливост"),
  question("BASE_STOPBANG_OBSERVED", "RISK", "Observed pauses in breathing", "Наблюдавани паузи в дишането"),
  question("BASE_STOPBANG_BP", "RISK", "High blood pressure", "Високо кръвно налягане"),
  question("BASE_STOPBANG_NECK", "RISK", "Neck circumference over 40 cm", "Обиколка на шията над 40 cm"),
  question("BASE_SURGERY_URGENCY", "CASE", "Surgery urgency", "Спешност на операцията", [
    { key: "ELECTIVE", labelEn: "Elective", labelBg: "Планова" },
    { key: "EMERGENCY", labelEn: "Emergency", labelBg: "Спешна" },
  ]),
  question("BASE_SURGERY_RISK", "CASE", "Surgery risk", "Риск на операцията", [
    { key: "LOW", labelEn: "Low risk", labelBg: "Нисък риск" },
    { key: "HIGH", labelEn: "High risk", labelBg: "Висок риск" },
  ]),
  question("BASE_POVOC_SURGERY_30_MINUTES", "PEDIATRIC_RISK", "Surgery expected to last at least 30 minutes", "Операция с очаквана продължителност поне 30 минути", [], { applicability: ["PEDIATRIC"] }),
  question("BASE_POVOC_STRABISMUS_SURGERY", "PEDIATRIC_RISK", "Strabismus surgery", "Операция за страбизъм", [], { applicability: ["PEDIATRIC"] }),
  question("BASE_POVOC_HISTORY", "PEDIATRIC_RISK", "Patient or family history of postoperative vomiting", "Лична или фамилна анамнеза за следоперативно повръщане", [], { applicability: ["PEDIATRIC"] }),
  question("BASE_COLDS_APPLICABLE", "PEDIATRIC_RISK", "Current or recent upper respiratory infection", "Настояща или скорошна инфекция на горните дихателни пътища", [], { applicability: ["PEDIATRIC"] }),
  question("BASE_PEDIATRIC_FASTING", "PEDIATRIC_SAFETY", "Paediatric fasting assessment", "Педиатрична оценка на гладуването", [], { applicability: ["PEDIATRIC"], answerType: "TEXT" }),
]

const adult = [
  question("A1_RECENT_INFECTION", "ADULT_ADDITIONS", "Recent fever, cold, or respiratory infection", "Скорошна температура, настинка или респираторна инфекция", [], { applicability: ["ADULT"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_A1_RECENT_INFECTION" }),
  question("A1_RECENT_INFECTION_TWO_WEEKS", "ADULT_ADDITIONS", "In the past two weeks?", "През последните две седмици?", [], { applicability: ["ADULT"], conditionalRuleKey: "A1_RECENT_INFECTION_IS_YES", omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_A1_RECENT_INFECTION_TWO_WEEKS" }),
  question("A2_REDUCED_EXERCISE_TOLERANCE", "ADULT_ADDITIONS", "Reduced exercise tolerance", "Намалена физическа издръжливост", [], { applicability: ["ADULT"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_A2_REDUCED_EXERCISE_TOLERANCE" }),
  question("A2_CAN_CLIMB_TWO_FLIGHTS", "ADULT_ADDITIONS", "Can you climb two flights of stairs without stopping?", "Можете ли да изкачите два етажа по стълби без спиране?", [], { applicability: ["ADULT"], conditionalRuleKey: "A2_REDUCED_EXERCISE_TOLERANCE_IS_YES", omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_A2_CAN_CLIMB_TWO_FLIGHTS" }),
  question("A3_UNINTENTIONAL_WEIGHT_LOSS", "ADULT_ADDITIONS", "Unintentional weight loss", "Непреднамерена загуба на тегло", [], { applicability: ["ADULT"], omopDomain: "condition_occurrence", omopConceptId: A3_WEIGHT_LOSS_CONCEPT_ID, omopVocabulary: "SNOMED", omopSourceCode: "40491502" }),
  question("A4_ADL_DEPENDENCE", "ADULT_ADDITIONS", "Dependence in activities of daily living", "Зависимост при ежедневни дейности", [], { applicability: ["ADULT"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_A4_ADL_DEPENDENCE" }),
  question("A4_ADL_WASHING", "ADULT_ADDITIONS", "Difficulty with washing?", "Затруднения при измиване?", [], { applicability: ["ADULT"], conditionalRuleKey: "A4_ADL_DEPENDENCE_IS_YES" }),
  question("A4_ADL_DRESSING", "ADULT_ADDITIONS", "Difficulty with dressing?", "Затруднения при обличане?", [], { applicability: ["ADULT"], conditionalRuleKey: "A4_ADL_DEPENDENCE_IS_YES" }),
  question("A4_ADL_WALKING", "ADULT_ADDITIONS", "Difficulty with walking?", "Затруднения при ходене?", [], { applicability: ["ADULT"], conditionalRuleKey: "A4_ADL_DEPENDENCE_IS_YES" }),
  question("A4_ADL_TOILETING", "ADULT_ADDITIONS", "Difficulty using the toilet?", "Затруднения при ползване на тоалетна?", [], { applicability: ["ADULT"], conditionalRuleKey: "A4_ADL_DEPENDENCE_IS_YES" }),
  question("A5_FALLS_LAST_12_MONTHS", "ADULT_ADDITIONS", "Falls during the last 12 months", "Падания през последните 12 месеца", [], { applicability: ["ADULT"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_A5_FALLS_LAST_12_MONTHS" }),
  question("A5_FALL_INJURY_MEDICAL_ATTENTION", "ADULT_ADDITIONS", "Fall-related injury requiring medical attention?", "Травма при падане, изискваща медицинска помощ?", [], { applicability: ["ADULT"], conditionalRuleKey: "A5_FALLS_LAST_12_MONTHS_IS_YES" }),
  question("A6_POST_ANAESTHESIA_CONFUSION", "ADULT_ADDITIONS", "Confusion or memory problems after anaesthesia?", "Объркване или проблеми с паметта след анестезия?", [], { applicability: ["ADULT"], conditionalRuleKey: "BASE_UNEXPLAINED_ANAESTHESIA_COMPLICATIONS_IS_YES" }),
  question("A7_VTE_HISTORY", "ADULT_ADDITIONS", "History of venous thromboembolism", "Анамнеза за венозен тромбоемболизъм", [], { applicability: ["ADULT"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_A7_VTE_HISTORY" }),
  question("A7_DVT", "ADULT_ADDITIONS", "Deep-vein thrombosis?", "Дълбока венозна тромбоза?", [], { applicability: ["ADULT"], conditionalRuleKey: "A7_VTE_HISTORY_IS_YES" }),
  question("A7_PE", "ADULT_ADDITIONS", "Pulmonary embolism?", "Белодробна емболия?", [], { applicability: ["ADULT"], conditionalRuleKey: "A7_VTE_HISTORY_IS_YES" }),
  question("A8_ABNORMAL_BLEEDING", "ADULT_ADDITIONS", "Abnormal bleeding history", "Анамнеза за абнормно кървене", [], { applicability: ["ADULT"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_A8_ABNORMAL_BLEEDING" }),
  question("A8_BLEEDING_AFTER_PROCEDURE", "ADULT_ADDITIONS", "Abnormal bleeding after an operation or dental procedure?", "Абнормно кървене след операция или стоматологична процедура?", [], { applicability: ["ADULT"], conditionalRuleKey: "A8_ABNORMAL_BLEEDING_IS_YES" }),
  question("A8_FAMILY_BLEEDING", "ADULT_ADDITIONS", "Family history of abnormal bleeding?", "Фамилна анамнеза за абнормно кървене?", [], { applicability: ["ADULT"], conditionalRuleKey: "A8_ABNORMAL_BLEEDING_IS_YES" }),
  question("A9_TRANSFUSION_HISTORY", "ADULT_ADDITIONS", "Previous blood transfusion / transfusion reaction", "Предишно кръвопреливане / реакция при кръвопреливане", [], { applicability: ["ADULT"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_A9_TRANSFUSION_HISTORY" }),
  question("A9_PREVIOUS_TRANSFUSION", "ADULT_ADDITIONS", "Previous blood transfusion?", "Предишно кръвопреливане?", [], { applicability: ["ADULT"], conditionalRuleKey: "A9_TRANSFUSION_HISTORY_IS_YES" }),
  question("A9_TRANSFUSION_REACTION", "ADULT_ADDITIONS", "Transfusion reaction?", "Реакция при кръвопреливане?", [], { applicability: ["ADULT"], conditionalRuleKey: "A9_TRANSFUSION_HISTORY_IS_YES" }),
  question("A9_BLOOD_ANTIBODIES", "ADULT_ADDITIONS", "Known blood antibodies or difficult crossmatch?", "Известни антитела или затруднено пробно съвместяване?", [], { applicability: ["ADULT"], conditionalRuleKey: "A9_TRANSFUSION_HISTORY_IS_YES" }),
  question("A11_DYSPHAGIA_ASPIRATION", "ADULT_ADDITIONS", "History of dysphagia or aspiration", "Анамнеза за дисфагия или аспирация", [], { applicability: ["ADULT"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_A11_DYSPHAGIA_ASPIRATION" }),
  question("A11_SOLID_FOOD", "ADULT_ADDITIONS", "Difficulty swallowing solid food?", "Затруднения при преглъщане на твърда храна?", [], { applicability: ["ADULT"], conditionalRuleKey: "A11_DYSPHAGIA_ASPIRATION_IS_YES" }),
  question("A11_LIQUIDS", "ADULT_ADDITIONS", "Difficulty swallowing liquids?", "Затруднения при преглъщане на течности?", [], { applicability: ["ADULT"], conditionalRuleKey: "A11_DYSPHAGIA_ASPIRATION_IS_YES" }),
  question("A11_PREVIOUS_ASPIRATION", "ADULT_ADDITIONS", "Previous aspiration episode?", "Предишен епизод на аспирация?", [], { applicability: ["ADULT"], conditionalRuleKey: "A11_DYSPHAGIA_ASPIRATION_IS_YES" }),
  question("A12_PACEMAKER_ICD", "ADULT_ADDITIONS", "Pacemaker / implantable cardioverter-defibrillator", "Пейсмейкър / имплантируем кардиовертер-дефибрилатор", [], { applicability: ["ADULT"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_A12_PACEMAKER_ICD" }),
  question("A13_PREGNANCY", "ADULT_ADDITIONS", "Pregnancy / possible pregnancy", "Бременност / възможна бременност", [], { applicability: ["ADULT"], allowNotApplicable: true, omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_A13_PREGNANCY" }),
  question("A13_GESTATIONAL_AGE_KNOWN", "ADULT_ADDITIONS", "Is gestational age known?", "Известна ли е гестационната възраст?", [], { applicability: ["ADULT"], allowNotApplicable: true, conditionalRuleKey: "A13_PREGNANCY_IS_YES" }),
  question("A14_BREASTFEEDING", "ADULT_ADDITIONS", "Breastfeeding", "Кърмене", [], { applicability: ["ADULT"], allowNotApplicable: true, omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_A14_BREASTFEEDING" }),
  question("A14_CONTINUE_BREASTFEEDING", "ADULT_ADDITIONS", "Intends to continue breastfeeding after anaesthesia?", "Възнамерява ли да продължи кърменето след анестезия?", [], { applicability: ["ADULT"], allowNotApplicable: true, conditionalRuleKey: "A14_BREASTFEEDING_IS_YES" }),
]

const pediatric = [
  question("P1_PREMATURITY_NICU", "PEDIATRIC_ADDITIONS", "Prematurity / neonatal intensive care history", "Недоносеност / анамнеза за неонатологично интензивно лечение", [], { applicability: ["PEDIATRIC"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_P1_PREMATURITY_NICU" }),
  question("P1_BORN_BEFORE_37_WEEKS", "PEDIATRIC_ADDITIONS", "Born before 37 weeks of gestation?", "Родено ли е детето преди 37-ата гестационна седмица?", [], { applicability: ["PEDIATRIC"], conditionalRuleKey: "P1_PREMATURITY_NICU_IS_YES" }),
  question("P1_NICU_ADMISSION", "PEDIATRIC_ADDITIONS", "Admission to neonatal intensive care?", "Приемано ли е детето в неонатологично интензивно отделение?", [], { applicability: ["PEDIATRIC"], conditionalRuleKey: "P1_PREMATURITY_NICU_IS_YES" }),
  question("P1_GESTATIONAL_AGE_KNOWN", "PEDIATRIC_ADDITIONS", "Is gestational age at birth known?", "Известна ли е гестационната възраст при раждане?", [], { applicability: ["PEDIATRIC"], conditionalRuleKey: "P1_PREMATURITY_NICU_IS_YES" }),
  question("P2_HOME_OXYGEN_NIV", "PEDIATRIC_ADDITIONS", "Home oxygen / non-invasive ventilation", "Домашна кислородотерапия / неинвазивна вентилация", [], { applicability: ["PEDIATRIC"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_P2_HOME_OXYGEN_NIV" }),
  question("P3_FEEDING_SWALLOWING", "PEDIATRIC_ADDITIONS", "Feeding or swallowing difficulty", "Затруднения при хранене или преглъщане", [], { applicability: ["PEDIATRIC"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_P3_FEEDING_SWALLOWING" }),
  question("P3_CHOKING_FEEDING", "PEDIATRIC_ADDITIONS", "Choking during feeding?", "Задавяне по време на хранене?", [], { applicability: ["PEDIATRIC"], conditionalRuleKey: "P3_FEEDING_SWALLOWING_IS_YES" }),
  question("P3_ASPIRATION_FEEDING", "PEDIATRIC_ADDITIONS", "Aspiration during feeding?", "Аспирация по време на хранене?", [], { applicability: ["PEDIATRIC"], conditionalRuleKey: "P3_FEEDING_SWALLOWING_IS_YES" }),
  question("P3_FEEDING_TUBE", "PEDIATRIC_ADDITIONS", "Feeding tube?", "Хранене чрез сонда?", [], { applicability: ["PEDIATRIC"], conditionalRuleKey: "P3_FEEDING_SWALLOWING_IS_YES" }),
  question("P4_SLEEP_DISORDERED_BREATHING", "PEDIATRIC_ADDITIONS", "Sleep-disordered breathing", "Нарушено дишане по време на сън", [], { applicability: ["PEDIATRIC"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_P4_SLEEP_DISORDERED_BREATHING" }),
  question("P4_LOUD_SNORING", "PEDIATRIC_ADDITIONS", "Loud snoring?", "Силно хъркане?", [], { applicability: ["PEDIATRIC"], conditionalRuleKey: "P4_SLEEP_DISORDERED_BREATHING_IS_YES" }),
  question("P4_OBSERVED_PAUSES", "PEDIATRIC_ADDITIONS", "Observed pauses in breathing during sleep?", "Наблюдавани паузи в дишането по време на сън?", [], { applicability: ["PEDIATRIC"], conditionalRuleKey: "P4_SLEEP_DISORDERED_BREATHING_IS_YES" }),
  question("P8_DIFFICULT_VENOUS_ACCESS", "PEDIATRIC_ADDITIONS", "Difficult venous access history", "Анамнеза за труден венозен достъп", [], { applicability: ["PEDIATRIC"], omopDomain: "observation", omopSourceCode: "LOSPOR:PREOP_P8_DIFFICULT_VENOUS_ACCESS" }),
]

/**
 * OMOP mapping for every question: [observation concept, source value].
 *
 * Rules: a LOINC question concept where one names the question itself (how
 * OMOP represents questionnaire items); a combined "X or Y" question gets 0
 * and its follow-ups carry the specific concepts; a nearby concept that says
 * something else is never borrowed.
 *
 * The answer is the value (Yes 4188539 / No 4188540); the concept is the
 * clinical fact the question asks about. 0 means no standard concept says what
 * the question says -- the answer still exports, under its LOSPOR source value,
 * and no concept is invented. Every non-zero id was checked as a standard
 * concept against the local Athena bundle (athena-20260913).
 *
 * Baseline source values are the ones the exporter already used, so a query
 * written against earlier exports keeps working.
 */
const OMOP: Record<string, readonly [number, string]> = {
  BASE_ALLERGIES: [3013237, "LOSPOR:ALLERGY_PRESENT"], // History of allergies, reported (LOINC)
  BASE_LATEX_ALLERGY: [43530807, "LOSPOR:LATEX_ALLERGY"], // Allergic disposition
  BASE_FAMILY_ANAESTHESIA_PROBLEMS: [764557, "LOSPOR:FAMILY_ANAESTHESIA_PROBLEMS"], // Family history of complication of anesthesia
  BASE_UNEXPLAINED_ANAESTHESIA_COMPLICATIONS: [37017043, "LOSPOR:UNEXPLAINED_ANAESTHESIA_COMPLICATIONS"], // Complication due to anesthesia during surgery
  BASE_MALIGNANT_HYPERTHERMIA_HISTORY: [440285, "LOSPOR:MALIGNANT_HYPERTHERMIA_HISTORY"], // Malignant hyperthermia
  BASE_ANTICIPATED_DIFFICULT_AIRWAY: [37159176, "LOSPOR:ANTICIPATED_DIFFICULT_AIRWAY"], // At increased risk for difficult tracheal intubation
  BASE_DENTAL_PROSTHETICS: [3029182, "LOSPOR:DENTAL_PROSTHETICS"], // Dental prosthesis (LOINC)
  BASE_LOOSE_TEETH: [4002000, "LOSPOR:LOOSE_TEETH"], // Abnormal tooth mobility
  BASE_SMOKING: [43054909, "LOSPOR:SMOKING"], // Tobacco smoking status (LOINC)
  BASE_SUBSTANCE_ABUSE: [4234597, "LOSPOR:SUBSTANCE_ABUSE"], // Misuses drugs
  BASE_HEART_ARRHYTHMIA: [44784217, "LOSPOR:HEART_ARRHYTHMIA"], // Cardiac arrhythmia
  BASE_RCRI_ISCHEMIC_HEART: [4185932, "LOSPOR:RCRI_ISCHEMIC_HEART"], // Ischemic heart disease
  BASE_RCRI_CHF: [319835, "LOSPOR:RCRI_CHF"], // Congestive heart failure
  BASE_RCRI_CVD: [381591, "LOSPOR:RCRI_CVD"], // Cerebrovascular disease
  BASE_RCRI_INSULIN_DM: [3046418, "LOSPOR:RCRI_INSULIN_DM"], // Insulin dependent diabetes mellitus [Presence] (LOINC question)
  BASE_RCRI_CREATININE: [0, "LOSPOR:RCRI_CREATININE"], // a > 2 mg/dL threshold, not a concept
  BASE_APFEL_PONV_HISTORY: [4032472, "LOSPOR:APFEL_PONV_HISTORY"], // Postoperative nausea and vomiting
  BASE_APFEL_POSTOP_OPIOIDS: [0, "LOSPOR:APFEL_POSTOP_OPIOIDS"], // a plan, not a finding
  BASE_STOPBANG_SNORING: [4248728, "LOSPOR:STOPBANG_SNORING"], // Snoring
  BASE_STOPBANG_TIRED: [42872394, "LOSPOR:STOPBANG_TIRED"], // Daytime somnolence
  BASE_STOPBANG_OBSERVED: [0, "LOSPOR:STOPBANG_OBSERVED_APNOEA"],
  BASE_STOPBANG_BP: [316866, "LOSPOR:STOPBANG_BP"], // Hypertensive disorder
  BASE_STOPBANG_NECK: [0, "LOSPOR:STOPBANG_NECK"], // a > 40 cm threshold
  BASE_SURGERY_URGENCY: [0, "LOSPOR:SURGERY_URGENCY"], // exported on the planned procedure (4093606 / 4013731)
  BASE_SURGERY_RISK: [4250613, "LOSPOR:HIGH_RISK_SURGERY"], // At increased risk for perioperative injury
  BASE_POVOC_SURGERY_30_MINUTES: [0, "LOSPOR:POVOC_SURGERY_30_MIN"],
  BASE_POVOC_STRABISMUS_SURGERY: [4214521, "LOSPOR:POVOC_STRABISMUS"], // Strabismus surgery
  BASE_POVOC_HISTORY: [0, "LOSPOR:POVOC_HISTORY"], // patient *or family* history
  BASE_COLDS_APPLICABLE: [4181583, "LOSPOR:COLDS_APPLICABLE"], // Upper respiratory infection
  BASE_PEDIATRIC_FASTING: [3031632, "LOSPOR:PEDIATRIC_FASTING_ASSESSMENT"], // Fasting status - Reported (LOINC)
  A1_RECENT_INFECTION: [0, "LOSPOR:PREOP_A1_RECENT_INFECTION"], // broader than 4181583 URI
  A1_RECENT_INFECTION_TWO_WEEKS: [0, "LOSPOR:PREOP_A1_RECENT_INFECTION_TWO_WEEKS"],
  A2_REDUCED_EXERCISE_TOLERANCE: [0, "LOSPOR:PREOP_A2_REDUCED_EXERCISE_TOLERANCE"], // 4086848 does not imply reduced
  A2_CAN_CLIMB_TWO_FLIGHTS: [0, "LOSPOR:PREOP_A2_CAN_CLIMB_TWO_FLIGHTS"], // 4013698 has inverted polarity
  A3_UNINTENTIONAL_WEIGHT_LOSS: [40491502, "LOSPOR:PREOP_A3_UNINTENTIONAL_WEIGHT_LOSS"], // Unintentional weight loss (condition)
  A4_ADL_DEPENDENCE: [0, "LOSPOR:PREOP_A4_ADL_DEPENDENCE"],
  A4_ADL_WASHING: [4109856, "LOSPOR:PREOP_A4_ADL_WASHING"], // Difficulty washing self
  A4_ADL_DRESSING: [4110925, "LOSPOR:PREOP_A4_ADL_DRESSING"], // Difficulty dressing
  A4_ADL_WALKING: [36714126, "LOSPOR:PREOP_A4_ADL_WALKING"], // Difficulty walking
  A4_ADL_TOILETING: [4110002, "LOSPOR:PREOP_A4_ADL_TOILETING"], // Difficulty using toilet
  A5_FALLS_LAST_12_MONTHS: [436583, "LOSPOR:PREOP_A5_FALLS_LAST_12_MONTHS"], // Fall
  A5_FALL_INJURY_MEDICAL_ATTENTION: [1761875, "LOSPOR:PREOP_A5_FALL_INJURY_MEDICAL_ATTENTION"], // History of fall related injury (LOINC question)
  A6_POST_ANAESTHESIA_CONFUSION: [0, "LOSPOR:PREOP_A6_POST_ANAESTHESIA_CONFUSION"], // confusion *or* memory problems; 4224115 covers confusion only
  A7_VTE_HISTORY: [0, "LOSPOR:PREOP_A7_VTE_HISTORY"], // no standard SNOMED VTE concept
  A7_DVT: [4133004, "LOSPOR:PREOP_A7_DVT"], // Deep venous thrombosis
  A7_PE: [440417, "LOSPOR:PREOP_A7_PE"], // Pulmonary embolism
  A8_ABNORMAL_BLEEDING: [0, "LOSPOR:PREOP_A8_ABNORMAL_BLEEDING"],
  A8_BLEEDING_AFTER_PROCEDURE: [0, "LOSPOR:PREOP_A8_BLEEDING_AFTER_PROCEDURE"],
  A8_FAMILY_BLEEDING: [0, "LOSPOR:PREOP_A8_FAMILY_BLEEDING"],
  A9_TRANSFUSION_HISTORY: [0, "LOSPOR:PREOP_A9_TRANSFUSION_HISTORY"], // transfusion *or* reaction: the follow-ups carry the concepts
  A9_PREVIOUS_TRANSFUSION: [4024656, "LOSPOR:PREOP_A9_PREVIOUS_TRANSFUSION"], // Transfusion of blood product
  A9_TRANSFUSION_REACTION: [440603, "LOSPOR:PREOP_A9_TRANSFUSION_REACTION"], // Blood transfusion reaction
  A9_BLOOD_ANTIBODIES: [0, "LOSPOR:PREOP_A9_BLOOD_ANTIBODIES"],
  A11_DYSPHAGIA_ASPIRATION: [0, "LOSPOR:PREOP_A11_DYSPHAGIA_ASPIRATION"], // dysphagia *or* aspiration: a yes does not assert dysphagia
  A11_SOLID_FOOD: [0, "LOSPOR:PREOP_A11_SOLID_FOOD"],
  A11_LIQUIDS: [0, "LOSPOR:PREOP_A11_LIQUIDS"],
  A11_PREVIOUS_ASPIRATION: [0, "LOSPOR:PREOP_A11_PREVIOUS_ASPIRATION"],
  A12_PACEMAKER_ICD: [0, "LOSPOR:PREOP_A12_PACEMAKER_ICD"], // pacemaker *or* ICD; each concept covers one
  A13_PREGNANCY: [42528957, "LOSPOR:PREOP_A13_PREGNANCY"], // Pregnancy status (LOINC question)
  A13_GESTATIONAL_AGE_KNOWN: [0, "LOSPOR:PREOP_A13_GESTATIONAL_AGE_KNOWN"],
  A14_BREASTFEEDING: [40766616, "LOSPOR:PREOP_A14_BREASTFEEDING"], // Breastfeeding status (LOINC question)
  A14_CONTINUE_BREASTFEEDING: [0, "LOSPOR:PREOP_A14_CONTINUE_BREASTFEEDING"],
  P1_PREMATURITY_NICU: [0, "LOSPOR:PREOP_P1_PREMATURITY_NICU"], // prematurity *or* NICU: the follow-ups carry the concepts
  P1_BORN_BEFORE_37_WEEKS: [36675035, "LOSPOR:PREOP_P1_BORN_BEFORE_37_WEEKS"], // Prematurity of infant
  P1_NICU_ADMISSION: [3661417, "LOSPOR:PREOP_P1_NICU_ADMISSION"], // Admission to neonatal intensive care unit
  P1_GESTATIONAL_AGE_KNOWN: [0, "LOSPOR:PREOP_P1_GESTATIONAL_AGE_KNOWN"],
  P2_HOME_OXYGEN_NIV: [0, "LOSPOR:PREOP_P2_HOME_OXYGEN_NIV"], // oxygen *or* non-invasive ventilation
  P3_FEEDING_SWALLOWING: [0, "LOSPOR:PREOP_P3_FEEDING_SWALLOWING"], // feeding *or* swallowing: the follow-ups carry the concepts
  P3_CHOKING_FEEDING: [4096712, "LOSPOR:PREOP_P3_CHOKING_FEEDING"], // Choking
  P3_ASPIRATION_FEEDING: [0, "LOSPOR:PREOP_P3_ASPIRATION_FEEDING"],
  P3_FEEDING_TUBE: [0, "LOSPOR:PREOP_P3_FEEDING_TUBE"],
  P4_SLEEP_DISORDERED_BREATHING: [0, "LOSPOR:PREOP_P4_SLEEP_DISORDERED_BREATHING"], // OSA 442588 is narrower
  P4_LOUD_SNORING: [4248728, "LOSPOR:PREOP_P4_LOUD_SNORING"], // Snoring
  P4_OBSERVED_PAUSES: [0, "LOSPOR:PREOP_P4_OBSERVED_PAUSES"],
  P8_DIFFICULT_VENOUS_ACCESS: [4115246, "LOSPOR:PREOP_P8_DIFFICULT_VENOUS_ACCESS"], // Difficult venous access
}

/** Where a question renders. Unlisted questions (and follow-ups of listed ones) are anamnesis. */
const FORM_SECTION: Record<string, PreopFormSection> = {
  BASE_ANTICIPATED_DIFFICULT_AIRWAY: "airway",
  BASE_HEART_ARRHYTHMIA: "physical_exam",
  BASE_SURGERY_URGENCY: "case_details",
  BASE_SURGERY_RISK: "case_details",
  BASE_POVOC_SURGERY_30_MINUTES: "risk_scores",
  BASE_POVOC_STRABISMUS_SURGERY: "risk_scores",
  BASE_POVOC_HISTORY: "risk_scores",
  BASE_COLDS_APPLICABLE: "risk_scores",
  A11_DYSPHAGIA_ASPIRATION: "airway",
  A12_PACEMAKER_ICD: "physical_exam",
  A13_PREGNANCY: "demographics",
  A14_BREASTFEEDING: "demographics",
  P3_FEEDING_SWALLOWING: "airway",
  P4_SLEEP_DISORDERED_BREATHING: "airway",
  P8_DIFFICULT_VENOUS_ACCESS: "physical_exam",
}

function parentOf(item: Omit<PreopCatalogQuestion, "formSection">): string | undefined {
  return /^(.+)_IS_YES$/.exec(item.conditionalRuleKey ?? "")?.[1]
}

function withMapping(items: Omit<PreopCatalogQuestion, "formSection">[]): PreopCatalogQuestion[] {
  const byKey = new Map(items.map(item => [item.stableKey, item]))
  const sectionOf = (key: string): PreopFormSection => {
    if (FORM_SECTION[key]) return FORM_SECTION[key]
    const item = byKey.get(key)
    const parent = item ? parentOf(item) : undefined
    return parent ? sectionOf(parent) : "anamnesis"
  }
  return items.map(item => {
    const omop = OMOP[item.stableKey]
    const parentKey = parentOf(item)
    const options = item.stableKey === "BASE_SURGERY_RISK"
      // High versus low risk is the yes/no of "at increased risk".
      ? item.options.map(option => ({ ...option, omopConceptId: option.key === "HIGH" ? YES_CONCEPT_ID : NO_CONCEPT_ID, omopVocabulary: "SNOMED" }))
      : item.options
    return {
      ...item,
      options,
      ...(parentKey ? { parentKey } : {}),
      formSection: sectionOf(item.stableKey),
      // Urgency is a modifier on the planned procedure (4093606 Emergency /
      // 4013731 Elective), exported there rather than as an observation.
      omopDomain: item.stableKey === "BASE_SURGERY_URGENCY"
        ? "procedure_modifier"
        : item.stableKey === "A3_UNINTENTIONAL_WEIGHT_LOSS" ? "condition_occurrence" : "observation",
      ...(omop ? { omopConceptId: omop[0], omopSourceCode: omop[1] } : {}),
    }
  })
}

export const BUNDLED_PREOP_QUESTIONS: readonly PreopCatalogQuestion[] = Object.freeze(withMapping([
  ...baseline,
  ...adult,
  ...pediatric,
]))

export const DEFAULT_ENABLED_QUESTION_KEYS = new Set(
  baseline.map(item => item.stableKey),
)

export function bundledQuestion(stableKey: string): PreopCatalogQuestion | undefined {
  return BUNDLED_PREOP_QUESTIONS.find(item => item.stableKey === stableKey)
}

export function bundledQuestionKeys(): string[] {
  return BUNDLED_PREOP_QUESTIONS.map(item => item.stableKey)
}
