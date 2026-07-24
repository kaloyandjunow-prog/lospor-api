// Centralised magic-number constants for the LOSPOR web app.
// Import from here instead of inlining literals in route files.
import {
  INTRAOP_COLUMN_MS,
  INTRAOP_RESUME_WINDOW_MS,
} from "@lospor/core/intraop-engine"

export const JWT_TTL_SECONDS           = 8 * 60 * 60            // 8 hours
export const RATE_LIMIT_WINDOW_MS      = 15 * 60 * 1000         // 15 minutes
export const TIMETABLE_INTERVAL_MS     = INTRAOP_COLUMN_MS
export const AI_MAX_REQUESTS_PER_HOUR  = 20
export const AI_BURST_COOLDOWN_MS      = 3_000                  // 3 seconds between AI requests
export const AI_PAYLOAD_MAX_BYTES      = 16 * 1024              // 16 KB
export const AI_STREAM_TIMEOUT_MS      = 30_000                 // 30 seconds
export const FINALIZE_UNDO_WINDOW_MS   = INTRAOP_RESUME_WINDOW_MS
export const CASE_LIST_DEFAULT_TAKE    = 50
export const CASE_LIST_MAX_TAKE        = 200
