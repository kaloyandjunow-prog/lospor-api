/**
 * ICD-10 ranking moved to `@lospor/core/search` in 8.4.0 so the API, the web
 * app and the offline mobile vocabulary all rank identically. This module stays
 * as the API's import surface; the logic itself is shared.
 */
export {
  formatIcd10Result,
  isIcd10CodeLikeQuery,
  mergeIcd10Results,
  ICD10_CODE_CONFIDENCE,
  ICD10_CODE_TAKE,
  ICD10_LABEL_PREFIX_MAX_LENGTH,
  ICD10_LABEL_TAKE,
  type Icd10SearchResult,
  type Icd10SearchRow,
} from "@lospor/core/search"
