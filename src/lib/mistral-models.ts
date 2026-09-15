/**
 * Which Mistral models the AI features default to, pinned by dated
 * identifier.
 *
 * The routes below used to default to `open-mistral-7b` and
 * `pixtral-12b-2409`, which Mistral retired on 30 March 2025 and 31 December
 * 2025 respectively, so every AI feature failed the moment a key was
 * configured -- silently, since Mistral's own error for an unknown model
 * reads like any other request failure. A `-latest` alias would move
 * clinical behaviour under a release nobody chose, so only a dated
 * identifier is used here, matching the values the LOSPOR Hospital appliance
 * already ships (`apps/api/src/lib/hospital/external-ai-models.ts` there) so
 * the two products cannot drift on which model is considered current.
 *
 * `MISTRAL_MODEL`/`MISTRAL_VISION_MODEL` still override these for an
 * operator who wants a different model; these are only the default when
 * neither is set.
 *
 * Changing a value here is a release change: a new identifier belongs here
 * only once someone has checked what it does with clinical text and images.
 */

/** Mistral Small 4: the current small general model, Apache 2.0. */
export const DEFAULT_ADVISOR_MODEL = "mistral-small-2603"
/** Mistral Large 3: the strongest current model that reads images, Apache 2.0. */
export const DEFAULT_VISION_MODEL = "mistral-large-2512"
