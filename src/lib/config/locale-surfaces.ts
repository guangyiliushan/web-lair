/**
 * Locale surface map — the single source of truth for which internal paths
 * stay outside the `/{lang}` segment (ledger §9.18.2). Two consumers:
 *
 * - `vite.config.ts` derives the paraglide `routeStrategies` middleware
 *   overrides from the `*Matches()` helpers below.
 * - `src/lib/utils/href.ts` (`siteHref`) uses `isLocaleFreePath` to decide
 *   at render time whether an internal link receives a locale prefix.
 *
 * Keeping both on one module means the middleware configuration and the
 * runtime link helper can never drift apart (P3-b grill Q7).
 */

/** Paths that resolve their locale from the cookie chain (never prefixed). */
export const COOKIE_SURFACES = [
	'/',
	'/account',
	'/login',
	'/register',
	'/forgot-password',
	'/reset-password',
	'/verify-email'
] as const;

/** Cookie-chain subtrees (the admin shell). */
export const COOKIE_SURFACE_TREES = ['/admin'] as const;

/** Paths the i18n middleware skips entirely — they have no locale surface. */
export const EXCLUDED_SURFACE_TREES = ['/api', '/demo', '/i'] as const;

/**
 * Root-level files outside the language segment: links stay bare and the
 * middleware skips them. `/rss.xml` is deliberately absent — feeds live in
 * the language segment (`/{lang}/rss.xml`); only requests to the bare root
 * alias are excluded from the middleware (P3-b R2-Q2).
 */
export const ROOT_FILES = ['/sitemap.xml', '/robots.txt'] as const;

/**
 * `routeStrategies` match patterns for the cookie surfaces. The wildcard
 * form covers the `__data.json` requests as well (P3-a review R1-P2-1);
 * ordering matters — specific patterns must precede any later wildcard.
 */
export function cookieSurfaceMatches(): string[] {
	return [
		'/',
		...COOKIE_SURFACES.filter((path) => path !== '/').map((path) => `${path}/:path(.*)?`),
		...COOKIE_SURFACE_TREES.map((path) => `${path}/:path(.*)?`)
	];
}

/**
 * Root endpoints whose requests skip the i18n middleware exactly (no
 * wildcard form): the two root files plus the feed alias (P3-b R2-Q2).
 *
 * Caveat (review finding, verified against the generated runtime): the
 * middleware matches these patterns against the de-localised path, so
 * `/{lang}/rss.xml` is skipped as well and the ambient locale stays at the
 * base locale there. Feed handlers must read the locale from the request
 * path (`localeFromPath`) and never call `getLocale()`. Dropping the bare
 * `/rss.xml` entry would additionally let the middleware 307 the alias —
 * its 302 is pinned by e2e and must stay.
 */
export const ROOT_EXACT_EXCLUDES = ['/sitemap.xml', '/robots.txt', '/rss.xml'] as const;

/** `routeStrategies` match patterns for the middleware skip list. */
export function excludedSurfaceMatches(): string[] {
	return [...EXCLUDED_SURFACE_TREES.map((path) => `${path}/:path(.*)?`), ...ROOT_EXACT_EXCLUDES];
}

/** Runtime predicate for `siteHref`: does this pathname stay language-free? */
export function isLocaleFreePath(pathname: string): boolean {
	if (pathname === '/') return true;
	const inTree = (tree: string) => pathname === tree || pathname.startsWith(`${tree}/`);
	return (
		COOKIE_SURFACES.some((path) => path !== '/' && inTree(path)) ||
		COOKIE_SURFACE_TREES.some(inTree) ||
		EXCLUDED_SURFACE_TREES.some(inTree) ||
		ROOT_FILES.some((file) => pathname === file)
	);
}
