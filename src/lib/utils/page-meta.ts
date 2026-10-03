/**
 * Pages-line shared constants (mirrors `$lib/utils/note-meta`): the reserved
 * top-level slugs — system segments, platform routes and root files — in ONE
 * place, consumed both by `scripts/verify-pages.ts` (repository check) and by
 * the admin editor (slug validation, 2026-10-03 P2). `about` / `about-site`
 * are reserved for the protected default rows; the verify script and the
 * editor exempt the default rows themselves by slug equality.
 */
export const PAGE_RESERVED_SLUGS: ReadonlySet<string> = new Set([
	'about',
	'about-site',
	'admin',
	'api',
	'demo',
	'files',
	'i',
	'maps',
	'photos',
	'robots.txt',
	'rss.xml',
	'sitemap.xml'
]);

export function isReservedPageSlug(slug: string): boolean {
	return PAGE_RESERVED_SLUGS.has(slug);
}
