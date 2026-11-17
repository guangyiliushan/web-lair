/**
 * sanitizeErrorText strips secrets from log text for the drain and the
 * `links.check` builtin core; it lives in its own module so the strip-only
 * chain (links-check.ts -> links/job.ts) does not load the whole drain graph
 * (the drain re-exports it).
 *
 * Two hazards are stripped:
 * - drizzle's DrizzleQueryError embeds the full SQL AND its bound values after
 *   a "params:" marker; those values may carry secrets and may themselves
 *   contain newlines, so everything from the marker to the end is dropped -
 *   a line-wise filter would leave the tail of a multi-line value behind.
 * - Node parse errors embed raw URLs, and webhook/heartbeat/database URLs
 *   carry tokens or credentials.
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
