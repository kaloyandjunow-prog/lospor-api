/**
 * Shared data-mapping helpers for the POST and PATCH case routes.
 *
 * The three sections had nothing in common but a handful of coercion helpers,
 * so each now lives in ./_mappers/ as its own module. This file stays the
 * import path both routes already use, so splitting them moved no call sites.
 */
export { mapPreop, mapPreopUpdate } from "./_mappers/preop"
export { mapIntraop, mapIntraopUpdate } from "./_mappers/intraop"
export { mapPostop, mapPostopUpdate } from "./_mappers/postop"
