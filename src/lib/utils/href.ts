import { localizeHref, locales } from '$lib/paraglide/runtime';
import { isLocaleFreePath } from '$lib/config/locale-surfaces';

/**
 * Strategy-aware href for internal links (P3-b). Content paths receive the
 * current locale prefix; language-free surfaces (home, auth, account,
 * admin, api/demo/i, root files — see `$lib/config/locale-surfaces`) stay
 * bare; external URLs, protocol-relative URLs and bare anchors pass through
 * unchanged. Paths that already carry a locale segment are returned as-is
 * so callers can link to another language explicitly.
 */
export function siteHref(href: string): string {
	// Not an internal path: external URL, mailto:, protocol-relative or anchor.
	if (!href.startsWith('/') || href.startsWith('//')) return href;

	const boundary = href.search(/[?#]/);
	const path = boundary === -1 ? href : href.slice(0, boundary);
	const suffix = boundary === -1 ? '' : href.slice(boundary);

	// Already localised — trust the caller's explicit segment.
	for (const locale of locales) {
		if (path === `/${locale}` || path.startsWith(`/${locale}/`)) return href;
	}

	// Language-free surfaces stay bare; content surfaces get the prefix.
	if (isLocaleFreePath(path)) return href;
	return localizeHref(path) + suffix;
}

/**
 * Active-state comparison for nav items (review finding): both sides are
 * neutral paths (`deLocalizeHref` output) — `neutralPath` is the current
 * location, `target` the nav item's path. `/` matches exactly; everything
 * else matches itself or a descendant (`/posts` → `/posts/x`), never a mere
 * string prefix (`/posts-foo` must not light up `/posts`).
 */
export function isActivePath(neutralPath: string, target: string): boolean {
	if (target === '/') return neutralPath === '/';
	return neutralPath === target || neutralPath.startsWith(`${target}/`);
}
