/**
 * Object storage port (ledger §21): the app talks to RustFS only through
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
	put(key: string, data: Uint8Array, options?: PutOptions): Promise<{ etag: string | null }>;
	/** Resolves null when the object does not exist (404). */
	get(key: string): Promise<StoredObjectBody | null>;
	/** Resolves null when the object does not exist (404). */
	head(key: string): Promise<StoredObjectHead | null>;
	/** Idempotent: deleting a missing object resolves. */
	delete(key: string): Promise<void>;
}
