/**
 * PostgreSQL error codes, read through drizzle's error wrapper
 * (DrizzleQueryError carries the driver error on `cause`, occasionally
 * nested deeper). Used by route actions that translate constraint violations
 * into form errors instead of 500s, and by the jobs runtime.
 */
export function pgErrorCode(caught: unknown): string | undefined {
	let current: unknown = caught;
	for (let depth = 0; depth < 5 && current != null; depth++) {
		if (typeof current === 'object' && 'code' in current) {
			const code = (current as { code?: unknown }).code;
			if (typeof code === 'string') return code;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}
