/**
 * Log-text sanitizer shared by the drain and the `links.check` builtin core
 * (review round 2026-10-06: extracted from `drain.ts` so the strip-only
 * builtin chain - links-check.ts -> links/job.ts - does not have to load the
 * whole drain module graph; the drain re-exports for its existing consumers).
 *
 * Two hazards are stripped:
 *  - drizzle's DrizzleQueryError message embeds the full SQL AND its bound
 *    values ("params: ..." after the query line); bound values may carry
 *    content or secrets and may THEMSELVES contain newlines, so everything
 *    from the params marker to the end of the string is dropped (a line-wise
 *    filter would leave the tail of a multi-line value behind);
 *  - Node embeds raw URLs in parse errors ("Failed to parse URL from ..."),
 *    and webhook/heartbeat/database URLs carry tokens or credentials.
 */
export function sanitizeErrorText(raw: unknown): string {
	const text = typeof raw === 'string' ? raw : String(raw ?? '');
	const paramsIndex = text.search(/\r?\n\s*params:/);
	const withoutParams = paramsIndex === -1 ? text : text.slice(0, paramsIndex);
	const redacted = withoutParams.replace(/(?:https?|postgres(?:ql)?):\/\/[^\s'"]+/g, (url) => {
		try {
			// NOTE: `origin` is "null" for non-special schemes (postgres://),
			// so rebuild from protocol + host - host keeps the port.
			const parsed = new URL(url);
			return `${parsed.protocol}//${parsed.host}/...`;
		} catch {
			return '[url redacted]';
		}
	});
	return redacted.slice(0, 500);
}
