/**
 * Object storage port: the app talks to RustFS only through
 * this narrow interface — PUT/GET/DELETE/HEAD plus one idempotent bucket
 * guard. Presigned URLs are intentionally out of scope for v1; the write
 * path goes through the app proxy.
 */

export interface PutOptions {
	contentType?: string;
}

export interface StoredObjectHead {
	key: string;
	/** null when the object store did not report a Content-Length. */
	byteSize: number | null;
	contentType: string | null;
	etag: string | null;
}

export interface StoredObjectBody {
	body: ReadableStream<Uint8Array>;
	byteSize: number | null;
	contentType: string | null;
	etag: string | null;
	/** Content-Range reported by a ranged read (HTTP 206). */
	contentRange?: string | null;
	/** Storage response status (200 full · 206 partial). */
	status?: number;
}

export interface GetOptions {
	/**
	 * Single byte range, S3 dialect — either `{ start, end? }` (`end`
	 * INCLUSIVE; omit for an open end) or `{ suffix }` for the last N bytes.
	 */
	range?: { start: number; end?: number } | { suffix: number };
}

/**
 * Bucket versioning state.
 *
 * `off` covers both an explicitly "never enabled" bucket and a provider whose
 * dialect has no versioning at all (HTTP 501/NotImplemented): in both cases a
 * DELETE frees the bytes. `unknown` means the probe could not answer (403,
 * transport failure) — callers must FAIL CLOSED on it, never assume `off`.
 */
export type BucketVersioning = 'off' | 'enabled' | 'suspended' | 'unknown';

export interface BucketCapabilities {
	versioning: BucketVersioning;
	/** true when object lock is enabled; null when the probe could not tell. */
	objectLock: boolean | null;
}

/**
 * One reading of "what can this bucket do with a DELETE". Every guard —
 * probe, activation, purge, single-file delete — must reach the same verdict,
 * so the rule lives here once:
 *
 *   provable  both reads answered (unknown/null is NOT "off" — fail closed);
 *   reclaims  a plain DELETE actually frees the bytes.
 */
export interface DeletionAssessment {
	provable: boolean;
	reclaims: boolean;
}

export function assessDeletion(capabilities: BucketCapabilities): DeletionAssessment {
	return {
		provable: capabilities.versioning !== 'unknown' && capabilities.objectLock !== null,
		reclaims: capabilities.versioning === 'off' && capabilities.objectLock !== true
	};
}

/**
 * True when the provider is reachable-but-failing or unreachable:
 * the request cannot be served from this provider, and the app must NOT fall
 * back to another one — 503 is the honest answer.
 */
export function isStorageUnavailable(error: unknown): boolean {
	return error instanceof StorageError && (error.status === 0 || error.status >= 500);
}

/**
 * The one 503 wire contract for "active provider unavailable" — same status,
 * Retry-After and no-store on every route that serves bytes (it was written inline twice).
 */
export function storageUnavailableResponse(): Response {
	return new Response(null, {
		status: 503,
		headers: { 'retry-after': '30', 'cache-control': 'no-store' }
	});
}

/** Non-2xx storage response the caller cannot treat as "absent". */
export class StorageError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | null,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'StorageError';
	}
}

export interface ObjectStoragePort {
	/** Idempotent: creates the configured bucket when it is missing. */
	ensureBucket(): Promise<void>;
	/** Resolves when the bucket exists and these credentials can see it. */
	headBucket(): Promise<void>;
	/**
	 * Bucket versioning + object lock, read with the same credentials. Resolves
	 * `unknown`/null instead of guessing when the provider refuses.
	 */
	bucketCapabilities(): Promise<BucketCapabilities>;
	put(key: string, data: Uint8Array, options?: PutOptions): Promise<{ etag: string | null }>;
	/** Resolves null when the object does not exist (404). */
	get(key: string, options?: GetOptions): Promise<StoredObjectBody | null>;
	/** Resolves null when the object does not exist (404). */
	head(key: string): Promise<StoredObjectHead | null>;
	/** Idempotent: deleting a missing object resolves. */
	delete(key: string): Promise<void>;
}
