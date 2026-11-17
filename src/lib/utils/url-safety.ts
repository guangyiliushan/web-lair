/**
 * http(s)-only filter for URLs that reach an href or an img src: a
 * javascript:/data: value stored in the DB must never become a clickable link.
 * The render side does not rely on write-side validation; this is shared by the
 * projects loader and the project write paths (same table as `normalizeRepoUrl`'s
 * scheme handling).
 */
export function safeHttpUrl(value: string | null): string | null {
	if (value === null) return null;
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null;
	} catch {
		return null;
	}
}
