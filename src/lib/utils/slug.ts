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
