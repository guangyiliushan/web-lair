/**
 * http(s)-only filter for URLs that reach an href or an img src (P review
 * P2): a javascript:/data: value stored in the DB must never become a
 * clickable link. Write-side validation lands with batch A; the render side
 * does not rely on it. Shared by the projects loader today and the batch-A
 * write paths next (same table as `normalizeRepoUrl`'s scheme handling).
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
