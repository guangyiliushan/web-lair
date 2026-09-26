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
