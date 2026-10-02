import { env } from '$env/dynamic/private';

/**
 * Public origin for absolute URLs (feeds, robots.txt, canonical/hreflang):
 * the deploy batch pins ORIGIN to the canonical host. Returns null when it
 * is unset so callers fall back to the request origin — `pnpm dev` without
 * ORIGIN used to 500 the whole distribution surface (review finding).
 * Normalised through URL so trailing slashes and stray paths are squeezed
 * out.
 */
export function getPublicOrigin(): string | null {
	const origin = env.ORIGIN;
	if (!origin) return null;
	const url = new URL(origin);
	// `new URL('host:8080')` parses as protocol 'host:' instead of failing —
	// require an absolute http(s) origin so a misconfiguration cannot
	// silently produce a "null" origin down every consumer (second review
	// round, 2026-10-02).
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`[origin] ORIGIN must be an absolute http(s) URL: ${origin}`);
	}
	return url.origin;
}
