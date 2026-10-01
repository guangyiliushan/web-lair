import { env } from '$env/dynamic/private';

/**
 * Public origin for absolute URLs (feeds, robots.txt, canonical/hreflang):
 * the deploy batch pins ORIGIN to the canonical host. Returns null when it
 * is unset so callers fall back to the request origin — `pnpm dev` without
 * ORIGIN used to 500 the whole distribution surface (review finding).
 * Normalised through URL so trailing slashes and stray paths are squeezed
 * out, and a malformed value fails loudly at the point of use.
 */
export function getPublicOrigin(): string | null {
	const origin = env.ORIGIN;
	return origin ? new URL(origin).origin : null;
}
