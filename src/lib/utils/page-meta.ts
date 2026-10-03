/**
 * Pages-line shared constants (mirrors `$lib/utils/note-meta`): the reserved
 * top-level slugs — system segments, platform routes, root files and the
 * locale tags — in ONE place, consumed both by `scripts/verify-pages.ts`
 * (repository check) and by the admin editor (slug validation, 2026-10-03 P2).
 * `about` / `about-site` are reserved for the protected default rows; the
 * verify script and the editor exempt the default rows by slug equality.
 *
 * The locale tags are reserved too (P1b review): a page slug shaped like a
 * language segment would shadow the bare-language roots, which the P3-a
 * identity URL patterns deliberately keep as 404s. `page-meta.test.ts` keeps
 * this set in sync with `locales`; the [slug] route carries a second
 * read-side guard for rows that predate the entry.
 */
export const PAGE_RESERVED_SLUGS: ReadonlySet<string> = new Set([
	'about',
	'about-site',
	'admin',
	'api',
	'demo',
	'en',
	'files',
	'i',
	'ja',
	'maps',
	'photos',
	'robots.txt',
	'rss.xml',
	'sitemap.xml',
	'zh-cn'
]);

export function isReservedPageSlug(slug: string): boolean {
	return PAGE_RESERVED_SLUGS.has(slug);
}
