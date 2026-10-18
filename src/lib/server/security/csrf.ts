/**
 * Framework-equivalent CSRF predicate.
 *
 * SvelteKit 2.70.3 performs this check in `respond.js` **before** `handle`,
 * so a hook cannot exempt a route. We therefore switch the framework check
 * off (`csrf.trustedOrigins: ['*']` in svelte.config.js) and run this
 * predicate as the first hook. Keep it byte-for-byte aligned with upstream:
 *
 * - `@sveltejs/kit/src/runtime/server/respond.js:74-93` (production only,
 *   form content types, mutating methods, missing Origin rejected)
 * - `@sveltejs/kit/src/utils/http.js:93-103` (content-type list)
 * - `@sveltejs/kit/src/runtime/form-utils.js:73` (binary enhanced forms)
 *
 * SvelteKit 3 additionally rejects mutating cross-origin requests that omit
 * Content-Type; add that clause when upgrading (`csrf.js` on `main`).
 */

/** `use:enhance` with File objects; not exported by the package. */
const BINARY_FORM_CONTENT_TYPE = 'application/x-sveltekit-formdata';

const FORM_CONTENT_TYPES = [
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
	BINARY_FORM_CONTENT_TYPE
] as const;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isFormContentType(request: Request): boolean {
	const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
	return (FORM_CONTENT_TYPES as readonly string[]).includes(type);
}

export interface CsrfInput {
	request: Request;
	/** `event.url.origin` (adapter-node: the ORIGIN env value). */
	selfOrigin: string;
	trustedOrigins?: string[];
}

export function isCsrfForbidden({ request, selfOrigin, trustedOrigins = [] }: CsrfInput): boolean {
	const origin = request.headers.get('origin');
	return (
		isFormContentType(request) &&
		MUTATING_METHODS.has(request.method) &&
		origin !== selfOrigin &&
		(!origin || !trustedOrigins.includes(origin))
	);
}
