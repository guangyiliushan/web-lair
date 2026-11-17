// Slug normalization shared by the client (live input filtering) and reused
// anywhere a slug is composed from arbitrary text. Lives in lib/utils so
// client code can import it — $lib/server is browser-forbidden in SvelteKit.

/**
 * Normalize slug input: lowercase, strip anything but [a-z0-9-], collapse and
 * trim hyphens. Tolerates a trailing hyphen mid-edit; server-side SLUG_RE
 * validation remains the final gate.
 */
export function normalizeSlug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '')
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Tag slug rule (tags are ASCII-only).
 * URL-safe punctuation (`. _ + ~`) survives; every other run becomes one
 * hyphen. The `/` case was the bug: `UI/UX` used to yield `ui/ux`, which
 * splits the `/posts/tags/[slug]` route into two segments.
 */
export function tagSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9._+~-]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
}

/**
 * Printable-ASCII whitelist for tag names. Must stay in sync with the
 * `tags_name_ascii_check` / `tags_name_shape_check` constraints: three write
 * paths (post publish, media library, seed) all land on that CHECK.
 */
export const TAG_NAME_RE = /^[A-Za-z0-9 .,+#&'()/_-]+$/;

/** URL shape the derived slug must satisfy (mirrors `tags_slug_shape_check`). */
export const TAG_SLUG_RE = /^[a-z0-9][a-z0-9._+~-]*$/;

export function isValidTagName(name: string): boolean {
	if (!TAG_NAME_RE.test(name) || name.trim() !== name || name.length < 1 || name.length > 40) {
		return false;
	}
	// The predicate must close over the DERIVED slug: names like `.NET` or `_x`
	// satisfy the character whitelist but produce a slug the DB CHECK rejects
	// (23514 -> 500 on publish). Validating both keeps the seam honest.
	const slug = tagSlug(name);
	return slug.length > 0 && slug.length <= 60 && TAG_SLUG_RE.test(slug);
}

/**
 * Note title slug: unlike post slugs, Unicode letters
 * and digits are KEPT (diary titles are usually Chinese) so note URLs stay
 * readable. Lowercases Latin, collapses every run of whitespace/punctuation
 * into one hyphen, caps the length and trims the edges; a pure-punctuation
 * title still yields an empty slug, which publish validation rejects (posts
 * behave the same).
 */
const TITLE_SLUG_MAX = 120;

export function titleSlug(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.slice(0, TITLE_SLUG_MAX)
		.replace(/^-+|-+$/g, '');
}

/**
 * Grammar of generated slugs (the exact output alphabet of `titleSlug`).
 * Used to reject non-slug input BEFORE it reaches the database, so an
 * unparseable value answers 404 like any other unknown slug instead of
 * surfacing a driver-level 500.
 */
export function isPhotoSlug(value: string): boolean {
	return /^[\p{L}\p{N}-]{1,120}$/u.test(value);
}
