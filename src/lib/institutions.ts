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
 *
 * The id and the head-of-department rule live in @lospor/core because web and
 * mobile need them too — the settings menus have to know not to offer "leave"
 * to somebody already here. Re-exported rather than redefined so there is one
 * copy of the string.
 */
export { NO_INSTITUTION_ID, canHaveHeadOfDepartment } from "@lospor/core/account"
import { NO_INSTITUTION_ID } from "@lospor/core/account"

export const NO_INSTITUTION = {
  id: NO_INSTITUTION_ID,
  name: "Без институция",
  city: "—",
  country: "Bulgaria",
} as const

// canHaveHeadOfDepartment is re-exported above. "Без институция" cannot have
// one: it is not a department, the people in it share no workplace, and so
// nobody has standing to see everyone's cases. Granting it a head would hand
// one clinician sight of every unaffiliated clinician's work in the register.
// Administrators still see everything, which is the intended, auditable route.
