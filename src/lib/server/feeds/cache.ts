/**
 * Conditional-request helpers shared by the feed endpoints (P3-b review):
 * `If-None-Match` is an entity-tag LIST compared weakly (RFC 9110 §13.1.2 /
 * §8.8.1), and a strong-ETag responder that also emits `Last-Modified`
 * should honour `If-Modified-Since` (§13.1.3) when no `If-None-Match` is
 * present (a covering IMS must never be overridden by an INM mismatch —
 * the INM wins exclusively when it is present).
 */

/** Weak comparison of an `If-None-Match` header value against a strong ETag. */
export function ifNoneMatchMatches(header: string | null, etag: string): boolean {
	if (!header) return false;
	const candidate = etag.replace(/^W\//, '');
	return header.split(',').some((part) => {
		const value = part.trim();
		return value === '*' || value.replace(/^W\//, '') === candidate;
	});
}

/**
 * True when the client's `If-Modified-Since` (second granularity) already
 * covers the newest change; only consulted when `If-None-Match` is absent.
 */
export function ifModifiedSinceCovers(header: string | null, latest: Date | null): boolean {
	if (!header || !latest) return false;
	const since = Date.parse(header);
	if (Number.isNaN(since)) return false;
	// A Last-Modified of T is covered by an If-Modified-Since >= T: the
	// header cannot distinguish instants inside the same second.
	return Math.floor(latest.getTime() / 1000) <= Math.floor(since / 1000);
}
