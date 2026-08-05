// Shared local E2E credentials for API seed and smoke scripts.
export const E2E_EMAIL = process.env.E2E_EMAIL ?? "e2e@lospor.test"
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "E2e-Test-Pass!234"
export const E2E_RESEARCH_EMAIL = process.env.E2E_RESEARCH_EMAIL ?? "research-e2e@lospor.test"

// A cast rather than a single account: the institution, visibility and
// approval rules only mean anything with more than one person in the room, and
// with two institutions to keep separate.
//
// E2E_EMAIL above is the ADMIN, in E2E_INSTITUTION_A.
export const E2E_HOD_A_EMAIL    = process.env.E2E_HOD_A_EMAIL    ?? "hod-a-e2e@lospor.test"
export const E2E_MEMBER_A_EMAIL = process.env.E2E_MEMBER_A_EMAIL ?? "member-a-e2e@lospor.test"
export const E2E_HOD_B_EMAIL    = process.env.E2E_HOD_B_EMAIL    ?? "hod-b-e2e@lospor.test"
export const E2E_MEMBER_B_EMAIL = process.env.E2E_MEMBER_B_EMAIL ?? "member-b-e2e@lospor.test"

export const E2E_INSTITUTION_A = "e2e-institution"
export const E2E_INSTITUTION_B = "e2e-institution-b"
