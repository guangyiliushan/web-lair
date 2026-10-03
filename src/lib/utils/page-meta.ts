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
 * identity URL patterns deliberately keep as 404s. The (auth) segments are
 * listed because the verify script's route scan only reports same-named
 * `(site)` children (soft warnings); `page-meta.test.ts` keeps this set in
 * sync with `locales` and the first-level route tree, and the [slug] route
 * carries a second read-side guard for locale-shaped rows that predate the
 * entry.
 */
export const PAGE_RESERVED_SLUGS: ReadonlySet<string> = new Set([
	'about',
	'about-site',
	'admin',
	'api',
	'demo',
	'en',
	'files', // platform-reserved (asset surfaces live under /admin/files)
	'forgot-password',
	'i',
	'ja',
	'login',
	'maps', // platform-reserved (storage line keeps the map surface)
	'photos', // platform-reserved (storage line public pages)
	'register',
	'reset-password',
	'robots.txt', // defensive: SLUG_RE already rejects dots
	'rss.xml', // defensive: SLUG_RE already rejects dots
	'sitemap.xml', // defensive: SLUG_RE already rejects dots
	'verify-email',
	'zh-cn'
]);

export function isReservedPageSlug(slug: string): boolean {
	return PAGE_RESERVED_SLUGS.has(slug);
}
