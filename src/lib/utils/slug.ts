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
 * Tag slug rule, single-sourced (P1.1 review): lowercase + collapse whitespace
 * to hyphens. Deliberately NOT `normalizeSlug` - that one strips CJK, while
 * tag names are allowed to be non-ASCII (§9.4). Keep this exact behaviour when
 * calling it anywhere; the derived value is the tag's storage slug.
 */
export function tagSlug(name: string): string {
	return name.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Note title slug (notes plan v0.4 §8.3): unlike post slugs, Unicode letters
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
