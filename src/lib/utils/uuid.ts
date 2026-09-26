/**
 * UUID shape check for values that flow from URLs / form fields into uuid
 * columns. PostgreSQL raises 22P02 for malformed uuids, which would surface
 * as an unhandled 500 instead of the intended 404 / form error (P1.1 review).
 * Kept deliberately permissive on version/variant bits - the DB owns the
 * canonical check; this only separates "obviously not an id" from "an id".
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
	return typeof value === 'string' && UUID_RE.test(value);
}
