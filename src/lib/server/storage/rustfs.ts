import { EMPTY_PAYLOAD_SHA256, sha256Hex, signRequest, uriEncode } from './signature';
import type { RustFsConfig } from './config';
import {
	StorageError,
	type ObjectStoragePort,
	type PutOptions,
	type StoredObjectBody,
	type StoredObjectHead
} from './port';

/** Request timeout for storage calls; ≤25MB uploads over loopback fit easily. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Strict numeric header: absent or non-numeric → null (never 0 / NaN). */
function numericHeader(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

interface RustFsStorageOptions {
	fetchImpl?: typeof fetch;
	clock?: () => Date;
	timeoutMs?: number;
}

/**
 * S3-dialect adapter for RustFS (ledger §21): path-style addressing, SigV4
 * signing, and only the tested subset of verbs (PUT/GET/DELETE/HEAD). The
 * endpoint is loopback-only — RustFS itself is never exposed publicly; all
 * reads/writes flow through this adapter (v1 does not presign).
 */
export class RustFsStorage implements ObjectStoragePort {
	readonly #config: RustFsConfig;
	readonly #fetch: typeof fetch;
	readonly #clock: () => Date;
	readonly #timeoutMs: number;

	constructor(config: RustFsConfig, options: RustFsStorageOptions = {}) {
		this.#config = config;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#clock = options.clock ?? (() => new Date());
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** URL path for an object: bucket + key, encoded segment-wise. */
	#objectPath(key: string): string {
		const encoded = key
			.split('/')
			.filter((segment) => segment.length > 0)
			.map((segment) => uriEncode(segment, true))
			.join('/');
		return `/${this.#config.bucket}/${encoded}`;
	}

	async ensureBucket(): Promise<void> {
		const res = await this.#send('PUT', `/${this.#config.bucket}`);
		// 200 = created now; 409 = already owned (idempotent re-run).
		if (res.ok || res.status === 409) return;
		throw await this.#toError('ensureBucket', res);
	}

	async put(
		key: string,
		data: Uint8Array,
		options: PutOptions = {}
	): Promise<{ etag: string | null }> {
		const res = await this.#send('PUT', this.#objectPath(key), {
			payload: data,
			contentType: options.contentType
		});
		if (!res.ok) throw await this.#toError(`put ${key}`, res);
		return { etag: res.headers.get('etag') };
	}

	async get(key: string): Promise<StoredObjectBody | null> {
		const res = await this.#send('GET', this.#objectPath(key));
		if (res.status === 404) return null;
		if (!res.ok) throw await this.#toError(`get ${key}`, res);
		if (!res.body)
			throw new StorageError(`storage get ${key} failed: empty body`, res.status, null);
		return {
			body: res.body,
			byteSize: numericHeader(res.headers.get('content-length')),
			contentType: res.headers.get('content-type'),
			etag: res.headers.get('etag')
		};
	}

	async head(key: string): Promise<StoredObjectHead | null> {
		const res = await this.#send('HEAD', this.#objectPath(key));
		if (res.status === 404) return null;
		if (!res.ok) throw await this.#toError(`head ${key}`, res);
		return {
			key,
			byteSize: numericHeader(res.headers.get('content-length')),
			contentType: res.headers.get('content-type'),
			etag: res.headers.get('etag')
		};
	}

	async delete(key: string): Promise<void> {
		const res = await this.#send('DELETE', this.#objectPath(key));
		// Idempotent by contract: a missing object is already the goal state.
		if (res.ok || res.status === 404) return;
		throw await this.#toError(`delete ${key}`, res);
	}

	async #send(
		method: string,
		path: string,
		options: { payload?: Uint8Array; contentType?: string } = {}
	): Promise<Response> {
		const url = new URL(path, this.#config.endpoint);
		const payloadHash = options.payload ? sha256Hex(options.payload) : EMPTY_PAYLOAD_SHA256;
		// S3 requires `host` in SignedHeaders (the AWS SigV4 vectors sign it
		// too). The value is derived from the URL rather than sent as an
		// explicit header — undici sets Host from the URL itself.
		const headers: Array<[string, string]> = [['host', url.host]];
		if (options.contentType) headers.push(['content-type', options.contentType]);
		headers.push(['x-amz-content-sha256', payloadHash]);
		const signed = signRequest(
			{
				method,
				canonicalUri: path,
				headers,
				payloadHash,
				region: this.#config.region,
				service: 's3',
				date: this.#clock()
			},
			this.#config.credentials
		);
		const requestHeaders = new Headers();
		for (const [name, value] of signed.headers) requestHeaders.append(name, value);
		try {
			return await this.#fetch(url, {
				method,
				headers: requestHeaders,
				// TS 5.7+ genericizes typed arrays; Node's fetch accepts any
				// Uint8Array view at runtime, so adapt at the boundary.
				body: options.payload as unknown as BodyInit | undefined,
				signal: AbortSignal.timeout(this.#timeoutMs)
			});
		} catch (cause) {
			throw new StorageError(`storage request failed: ${method} ${path}`, 0, null, { cause });
		}
	}

	async #toError(operation: string, response: Response): Promise<StorageError> {
		let code: string | null = null;
		try {
			const text = await response.text();
			code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? null;
		} catch {
			// Body already consumed or unreadable — keep the status-only error.
		}
		return new StorageError(
			`storage ${operation} failed: HTTP ${response.status}${code ? ` (${code})` : ''}`,
			response.status,
			code
		);
	}
}
