/**
 * Conditional-request helpers shared by the feed endpoints (P3-b; second
 * review round 2026-10-02): `If-None-Match` is an entity-tag LIST compared
 * weakly (RFC 9110 §13.1.2 / §8.8.1).
 *
 * `If-Modified-Since` is deliberately NOT evaluated: our `Last-Modified` is
 * `max(updated_at)` of the visible set, which is not a consistent
 * last-modification date (RFC 9110 §8.8.2.1) — lazy visibility flips and
 * deletions change the body without writing a row, so honouring IMS there
 * would answer a stale 304 (independent double review + repro). The header
 * is still sent, informational only.
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

const FEED_CACHE_CONTROL = 'public, max-age=300';

/**
 * Conditional feed response (RFC 9110 §13.1): strong ETag, a 304 on a
 * matching `If-None-Match`, and the shared cache-control header. Shared by
 * the RSS and sitemap routes so the two cannot silently drift apart.
 */
export function conditionalResponse(
	request: Request,
	body: string,
	options: { contentType: string; etag: string; lastModified: Date | null }
): Response {
	const headers: Record<string, string> = {
		'content-type': options.contentType,
		'cache-control': FEED_CACHE_CONTROL,
		etag: options.etag
	};
	if (options.lastModified) headers['last-modified'] = options.lastModified.toUTCString();

	const notModified = ifNoneMatchMatches(request.headers.get('if-none-match'), options.etag);
	return new Response(notModified ? null : body, {
		status: notModified ? 304 : 200,
		headers
	});
}
