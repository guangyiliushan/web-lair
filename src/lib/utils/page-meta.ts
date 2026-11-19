/**
 * Pages-line shared constants, mirroring `$lib/utils/note-meta`: the reserved top-level
 * slugs — system segments, platform routes, root files and locale tags — in ONE place,
 * consumed both by `scripts/verify-pages.ts` (repository check) and by the admin editor
 * (slug validation); `about` / `about-site` protect the default rows, which both consumers
 * exempt by slug equality.
 * Locale tags are reserved because a page slug shaped like a language segment would shadow
 * the bare-language roots that the identity URL patterns deliberately keep as 404s; auth
 * segments are listed because the verify script's route scan only reports same-named `(site)`
 * children as soft warnings.
 * `page-meta.test.ts` keeps the set in sync with `locales` and the first-level route tree,
 * and the [slug] route carries a second read-side guard for locale-shaped legacy rows.
 */
export const PAGE_RESERVED_SLUGS: ReadonlySet<string> = new Set([
	'about',
	'about-site',
	'admin',
	'ai-disclosure',
	'api',
	'demo',
	'en',
	'files', // platform-reserved (asset surfaces live under /admin/files)
	'forgot-password',
	'i',
	'ja',
	'login',
	'llms.txt', // root llms file; SLUG_RE already rejects dots
	'manifest.webmanifest', // web manifest route; SLUG_RE rejects dots
	'maps', // platform-reserved (storage line keeps the map surface)
	'photos', // platform-reserved (storage line public pages)
	'privacy', // the public privacy notice
	'register',
	'reset-password',
	'robots.txt', // defensive: SLUG_RE already rejects dots
	'rss.xml', // defensive: SLUG_RE already rejects dots
	'sitemap.xml', // defensive: SLUG_RE already rejects dots
	'subscribe',
	'unsubscribe',
	'verify-email',
	'zh-cn'
]);

export function isReservedPageSlug(slug: string): boolean {
	return PAGE_RESERVED_SLUGS.has(slug);
}

/**
 * Marker for the auto-generated slug of never-published placeholder rows.
 * One literal for the whole pages line: the service (re-exported
 * for the admin routes and tests) and scripts/verify-pages.ts read it here,
 * so the verify-pages exemption and the editor's ownership predicate share
 * the exact same prefix. (scripts/verify-baseline.ts does not consume it.)
 */
export const PAGE_PLACEHOLDER_SLUG_PREFIX = 'draft-';

export function isPagePlaceholderSlug(slug: string): boolean {
	return slug.startsWith(PAGE_PLACEHOLDER_SLUG_PREFIX);
}
