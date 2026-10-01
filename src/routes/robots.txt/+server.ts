import { getPublicOrigin } from '$lib/server/origin';
import type { RequestHandler } from './$types';

/**
 * Dynamic robots.txt (P3-b, ledger §22): ORIGIN is the single source for
 * the Sitemap line, with a request-origin fallback in dev (review finding).
 * Minimal by design — crawl management only; admin and account pages are
 * protected by auth, not by robots (Google: robots.txt is not a mechanism
 * for keeping a page out of the index).
 */
export const GET: RequestHandler = async ({ url }) => {
	const origin = getPublicOrigin() ?? url.origin;
	const body = `User-agent: *\n\nSitemap: ${origin}/sitemap.xml\n`;

	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'public, max-age=300'
		}
	});
};
