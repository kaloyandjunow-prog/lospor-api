/**
 * The institution for clinicians who do not belong to a department here.
 *
 * Registration requires an institution, so this is what someone picks when
 * none of the real ones apply — a locum, a trainee between rotations, someone
 * evaluating the register. It is a real row rather than a null, because null
 * institutions were the thing that let cases drift: a case recorded with no
 * institution used to become visible to whichever department its author later
 * joined.
 *
 * A fixed id rather than a lookup by name. The name is Bulgarian, it is
 * displayed, and display strings get edited; the id is what the rules key on
 * and it is seeded with an upsert so re-seeding cannot mint a second one.
 */
export const NO_INSTITUTION_ID = "no-institution"

export const NO_INSTITUTION = {
  id: NO_INSTITUTION_ID,
  name: "Без институция",
  city: "—",
  country: "Bulgaria",
} as const

/**
 * Whether an institution can have a head of department.
 *
 * "Без институция" cannot. It is not a department: the people in it have no
 * shared workplace, so there is nobody with standing to see everyone's cases.
 * Granting it a head would hand one clinician sight of every unaffiliated
 * clinician's work in the whole register. Administrators still see everything,
 * which is the intended and auditable route.
 */
export function canHaveHeadOfDepartment(institutionId: string | null | undefined): boolean {
  return Boolean(institutionId) && institutionId !== NO_INSTITUTION_ID
}
