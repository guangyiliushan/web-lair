import { EMPTY_PAYLOAD_SHA256, sha256Hex, signRequest, uriEncode } from './signature';
import type { RustFsConfig } from './config';
import {
	StorageError,
	type GetOptions,
	type ObjectStoragePort,
	type PutOptions,
	type StoredObjectBody,
	type StoredObjectHead
} from './port';

/**
 * Read timeouts split by stage (ST-1 follow-up, landed before the pmtiles
 * Range work): stage 1 covers request start → response headers, stage 2
 * guards the streamed body against idle gaps — a slow but ACTIVE download
 * (pmtiles extracts) is never killed by a wall-clock cap the way a single
 * `AbortSignal.timeout` would.
 */
const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 30_000;
/** Error bodies are tiny; a stuck one must not stall the caller. */
const ERROR_BODY_TIMEOUT_MS = 5_000;

/** Bounded wait for tiny utility reads (error bodies). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

/**
 * Stage-2 body guard: each outstanding read must produce a chunk within `ms`
 * or the stream fails with a StorageError and the underlying fetch aborts.
 * The timer only runs while a read is pending — consumer-side backpressure
 * (a paused reader) is not an idle body.
 */
function guardIdleBody(
	source: ReadableStream<Uint8Array>,
	ms: number,
	onIdle: () => void,
	key: string
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let timer: ReturnType<typeof setTimeout> | null = null;
	const clear = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			timer = setTimeout(() => {
				onIdle();
				controller.error(
					new StorageError(`storage body idle timeout after ${ms}ms: ${key}`, 0, null)
				);
				void reader.cancel().catch(() => {});
			}, ms);
			try {
				const { done, value } = await reader.read();
				clear();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (cause) {
				clear();
				controller.error(cause);
			}
		},
		cancel(reason) {
			clear();
			return reader.cancel(reason);
		}
	});
}

/** Strict numeric header: absent or non-numeric → null (never 0 / NaN). */
function numericHeader(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

interface RustFsStorageOptions {
	fetchImpl?: typeof fetch;
	clock?: () => Date;
	/** Stage 1: request start → response headers. */
	headersTimeoutMs?: number;
	/** Stage 2: max gap between streamed body chunks (0 disables the guard). */
	bodyIdleTimeoutMs?: number;
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
	readonly #headersTimeoutMs: number;
	readonly #bodyIdleTimeoutMs: number;

	constructor(config: RustFsConfig, options: RustFsStorageOptions = {}) {
		this.#config = config;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#clock = options.clock ?? (() => new Date());
		this.#headersTimeoutMs = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
		this.#bodyIdleTimeoutMs = options.bodyIdleTimeoutMs ?? DEFAULT_BODY_IDLE_TIMEOUT_MS;
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
		const { response: res } = await this.#send('PUT', `/${this.#config.bucket}`);
		// 200 = created now; 409 = already owned (idempotent re-run).
		if (res.ok || res.status === 409) return;
		throw await this.#toError('ensureBucket', res);
	}

	async put(
		key: string,
		data: Uint8Array,
		options: PutOptions = {}
	): Promise<{ etag: string | null }> {
		const { response: res } = await this.#send('PUT', this.#objectPath(key), {
			payload: data,
			contentType: options.contentType
		});
		if (!res.ok) throw await this.#toError(`put ${key}`, res);
		return { etag: res.headers.get('etag') };
	}

	async get(key: string, options: GetOptions = {}): Promise<StoredObjectBody | null> {
		const { response: res, controller } = await this.#send('GET', this.#objectPath(key), {
			range: options.range
		});
		if (res.status === 404) return null;
		if (!res.ok) throw await this.#toError(`get ${key}`, res);
		if (!res.body)
			throw new StorageError(`storage get ${key} failed: empty body`, res.status, null);
		const body =
			this.#bodyIdleTimeoutMs > 0
				? guardIdleBody(res.body, this.#bodyIdleTimeoutMs, () => controller.abort(), key)
				: res.body;
		return {
			body,
			byteSize: numericHeader(res.headers.get('content-length')),
			contentType: res.headers.get('content-type'),
			etag: res.headers.get('etag'),
			contentRange: res.headers.get('content-range'),
			status: res.status
		};
	}

	async head(key: string): Promise<StoredObjectHead | null> {
		const { response: res } = await this.#send('HEAD', this.#objectPath(key));
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
		const { response: res } = await this.#send('DELETE', this.#objectPath(key));
		// Idempotent by contract: a missing object is already the goal state.
		if (res.ok || res.status === 404) return;
		throw await this.#toError(`delete ${key}`, res);
	}

	async #send(
		method: string,
		path: string,
		options: { payload?: Uint8Array; contentType?: string; range?: GetOptions['range'] } = {}
	): Promise<{ response: Response; controller: AbortController }> {
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
		// Range travels UNSIGNED (it is not in SignedHeaders): SigV4 verifies
		// only the listed headers and the S3 dialect permits extra unlisted
		// ones; the live RustFS probe pins the exact semantics.
		if (options.range) {
			const header =
				'suffix' in options.range
					? `bytes=-${options.range.suffix}`
					: `bytes=${options.range.start}-${options.range.end ?? ''}`;
			requestHeaders.set('range', header);
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.#headersTimeoutMs);
		try {
			const response = await this.#fetch(url, {
				method,
				headers: requestHeaders,
				// TS 5.7+ genericizes typed arrays; Node's fetch accepts any
				// Uint8Array view at runtime, so adapt at the boundary.
				body: options.payload as unknown as BodyInit | undefined,
				signal: controller.signal
			});
			return { response, controller };
		} catch (cause) {
			throw new StorageError(`storage request failed: ${method} ${path}`, 0, null, { cause });
		} finally {
			clearTimeout(timer);
		}
	}

	async #toError(operation: string, response: Response): Promise<StorageError> {
		let code: string | null = null;
		try {
			const text = await withTimeout(response.text(), ERROR_BODY_TIMEOUT_MS);
			code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? null;
		} catch {
			// Body already consumed, unreadable or slow — keep the status-only error.
		}
		return new StorageError(
			`storage ${operation} failed: HTTP ${response.status}${code ? ` (${code})` : ''}`,
			response.status,
			code
		);
	}
}
