/**
 * PostgreSQL error codes, read through drizzle's error wrapper
 * (DrizzleQueryError carries the driver error on `cause`). Used by route
 * actions that translate constraint violations into form errors instead of
 * 500s.
 */
export function pgErrorCode(caught: unknown): string | undefined {
	const err = caught as { code?: string; cause?: { code?: string } } | null;
	return err?.code ?? err?.cause?.code;
}
