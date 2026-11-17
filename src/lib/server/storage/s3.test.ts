import { describe, expect, it, vi } from 'vitest';
import { storageConfigFromEnv, type S3StorageConfig } from './config';
import { S3Storage } from './s3';
import { sha256Hex } from './signature';

const CONFIG = storageConfigFromEnv({
	RUSTFS_ENDPOINT: 'http://127.0.0.1:9000/',
	RUSTFS_ACCESS_KEY: 'test-key',
	RUSTFS_SECRET_KEY: 'test-secret',
	RUSTFS_BUCKET: 'web-lair'
});

/** Virtual-host configuration (AWS S3 / `r2`): bucket in the hostname. */
const VHOST_CONFIG: S3StorageConfig = {
	...CONFIG,
	endpoint: 'https://s3.us-east-1.amazonaws.com',
	forcePathStyle: false
};

const envLike = {
	RUSTFS_ENDPOINT: ' http://127.0.0.1:9000/ ',
	RUSTFS_ACCESS_KEY: 'test-key',
	RUSTFS_SECRET_KEY: 'test-secret',
	RUSTFS_BUCKET: 'web-lair'
};

/** Fixed clock so the signed x-amz-date is deterministic. */
const FIXED_CLOCK = () => new Date(Date.UTC(2026, 8, 29, 1, 2, 3));

interface CapturedCall {
	url: string;
	init: RequestInit;
}

function recordingFetch(respond: (call: CapturedCall) => Response | Promise<Response>) {
	const calls: CapturedCall[] = [];
	const impl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
		const call: CapturedCall = { url: String(input), init: init ?? {} };
		calls.push(call);
		return respond(call);
	}) as unknown as typeof fetch;
	return { impl, calls };
}

function storageWith(impl: typeof fetch): S3Storage {
	return new S3Storage(CONFIG, { fetchImpl: impl, clock: FIXED_CLOCK });
}

describe('storage config', () => {
	it('lists every missing key', () => {
		expect(() => storageConfigFromEnv({ RUSTFS_ENDPOINT: 'http://x' })).toThrow(
			/missing RUSTFS_ACCESS_KEY, RUSTFS_SECRET_KEY, RUSTFS_BUCKET/
		);
	});

	it('trims whitespace and trailing slashes from the endpoint', () => {
		const config = storageConfigFromEnv(envLike);
		expect(config.endpoint).toBe('http://127.0.0.1:9000');
		expect(config.region).toBe('us-east-1');
		expect(config.forcePathStyle).toBe(true);
	});

	it('rejects a non-http endpoint and one carrying credentials', () => {
		const base = { ...envLike };
		expect(() => storageConfigFromEnv({ ...base, RUSTFS_ENDPOINT: 'ftp://127.0.0.1:21' })).toThrow(
			/must be http/
		);
		expect(() =>
			storageConfigFromEnv({ ...base, RUSTFS_ENDPOINT: 'http://key:secret@127.0.0.1:9000' })
		).toThrow(/must not embed credentials/);
		expect(() => storageConfigFromEnv({ ...base, RUSTFS_ENDPOINT: 'not a url' })).toThrow(
			/not a URL/
		);
	});
});

describe('S3Storage (path style, bundled RustFS)', () => {
	it('PUT signs the request and encodes the object key segment-wise', async () => {
		const { impl, calls } = recordingFetch(
			() => new Response(null, { status: 200, headers: { etag: '"abc"' } })
		);
		const storage = storageWith(impl);
		const payload = new TextEncoder().encode('hello');

		const { etag } = await storage.put('ab/abc123.webp@thumb', payload, {
			contentType: 'image/webp'
		});

		expect(etag).toBe('"abc"');
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call.url).toBe('http://127.0.0.1:9000/web-lair/ab/abc123.webp%40thumb');
		expect(call.init.method).toBe('PUT');
		const headers = new Headers(call.init.headers);
		expect(headers.get('x-amz-date')).toBe('20260929T010203Z');
		expect(headers.get('x-amz-content-sha256')).toBe(sha256Hex(payload));
		expect(headers.get('content-type')).toBe('image/webp');
		expect(headers.get('authorization')).toMatch(
			/^AWS4-HMAC-SHA256 Credential=test-key\/20260929\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
		);
		expect(new TextDecoder().decode(call.init.body as Uint8Array)).toBe('hello');
	});

	it('never follows a redirect (SSRF: a 302 must not be chased)', async () => {
		const { impl, calls } = recordingFetch(() => new Response(null, { status: 200 }));
		const storage = storageWith(impl);

		await storage.head('a/one.bin');

		expect(calls[0]!.init.redirect).toBe('error');
	});

	it('rejects dot segments before any request hits the wire (round-2)', async () => {
		const { impl, calls } = recordingFetch(() => new Response(null, { status: 200 }));
		const storage = storageWith(impl);

		await expect(storage.put('a/../b', new Uint8Array(1))).rejects.toThrow(/dot segment/);
		await expect(storage.get('a/./b')).rejects.toThrow(/dot segment/);
		await expect(storage.head('')).rejects.toThrow(/empty/);
		expect(calls).toHaveLength(0);
	});

	it('GET maps 404 to null and streams the body otherwise', async () => {
		const missing = storageWith(recordingFetch(() => new Response(null, { status: 404 })).impl);
		expect(await missing.get('a/missing.bin')).toBeNull();

		const found = storageWith(
			recordingFetch(
				() =>
					new Response('body-bytes', {
						status: 200,
						headers: { 'content-length': '10', 'content-type': 'text/plain' }
					})
			).impl
		);
		const object = await found.get('a/found.txt');
		expect(object?.byteSize).toBe(10);
		expect(object?.contentType).toBe('text/plain');
		expect(await new Response(object!.body).text()).toBe('body-bytes');
	});

	it('HEAD maps 404 to null and reports size, type and etag on hit', async () => {
		const missing = storageWith(recordingFetch(() => new Response(null, { status: 404 })).impl);
		expect(await missing.head('a/missing.bin')).toBeNull();

		const found = storageWith(
			recordingFetch(
				() =>
					new Response(null, {
						status: 200,
						headers: { 'content-length': '42', 'content-type': 'image/webp', etag: '"v1"' }
					})
			).impl
		);
		expect(await found.head('a/found.webp')).toEqual({
			key: 'a/found.webp',
			byteSize: 42,
			contentType: 'image/webp',
			etag: '"v1"'
		});
	});

	it('DELETE is idempotent: a 404 resolves', async () => {
		const storage = storageWith(recordingFetch(() => new Response(null, { status: 404 })).impl);
		await expect(storage.delete('a/missing.bin')).resolves.toBeUndefined();
	});

	it('non-2xx raises StorageError with the S3 error code parsed', async () => {
		const storage = storageWith(
			recordingFetch(
				() =>
					new Response('<Error><Code>InternalError</Code><Message>boom</Message></Error>', {
						status: 500
					})
			).impl
		);
		await expect(storage.head('x')).rejects.toMatchObject({
			name: 'StorageError',
			status: 500,
			code: 'InternalError'
		});
	});

	it('network failures surface as StorageError with status 0', async () => {
		const impl = vi.fn(async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch;
		const storage = storageWith(impl);
		await expect(storage.delete('x')).rejects.toMatchObject({ name: 'StorageError', status: 0 });
	});

	it('ensureBucket is idempotent (409 already-owned resolves)', async () => {
		const { impl, calls } = recordingFetch(() => new Response(null, { status: 409 }));
		const storage = storageWith(impl);
		await expect(storage.ensureBucket()).resolves.toBeUndefined();
		expect(calls[0].url).toBe('http://127.0.0.1:9000/web-lair');
		expect(calls[0].init.method).toBe('PUT');
	});

	it('headBucket resolves on 200 and reports a missing bucket as 404', async () => {
		const ok = storageWith(recordingFetch(() => new Response(null, { status: 200 })).impl);
		await expect(ok.headBucket()).resolves.toBeUndefined();

		const missing = storageWith(recordingFetch(() => new Response(null, { status: 404 })).impl);
		await expect(missing.headBucket()).rejects.toMatchObject({
			name: 'StorageError',
			status: 404,
			code: 'NoSuchBucket'
		});

		const denied = storageWith(recordingFetch(() => new Response(null, { status: 403 })).impl);
		await expect(denied.headBucket()).rejects.toMatchObject({ status: 403 });
	});
});

describe('S3Storage bucket capabilities (W7.5)', () => {
	/** Answers GET ?versioning= / ?object-lock= independently. */
	function capabilityFetch(
		versioning: () => Response | Promise<Response>,
		objectLock: () => Response | Promise<Response>
	) {
		return recordingFetch((call) => {
			const url = new URL(call.url);
			if (url.searchParams.has('object-lock')) return objectLock();
			if (url.searchParams.has('versioning')) return versioning();
			return new Response(null, { status: 200 });
		});
	}

	const OFF_VERSIONING = () =>
		new Response(
			'<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></VersioningConfiguration>',
			{ status: 200 }
		);
	const NO_LOCK = () =>
		new Response('<Error><Code>ObjectLockConfigurationNotFoundError</Code></Error>', {
			status: 404
		});

	it('reads an untouched RustFS bucket as versioning off + lock off', async () => {
		const { impl, calls } = capabilityFetch(OFF_VERSIONING, NO_LOCK);
		const storage = storageWith(impl);

		await expect(storage.bucketCapabilities()).resolves.toEqual({
			versioning: 'off',
			objectLock: false
		});
		const urls = calls.map((call) => call.url);
		expect(urls).toContain('http://127.0.0.1:9000/web-lair?versioning=');
		expect(urls).toContain('http://127.0.0.1:9000/web-lair?object-lock=');
		const headers = new Headers(calls[0]!.init.headers);
		// The query travels inside the signature, not as a stray header.
		expect(headers.get('authorization')).toMatch(
			/SignedHeaders=host;x-amz-content-sha256;x-amz-date/
		);
	});

	it('reports enabled / suspended versioning', async () => {
		const enabled = storageWith(
			capabilityFetch(
				() =>
					new Response(
						'<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
						{ status: 200 }
					),
				NO_LOCK
			).impl
		);
		expect((await enabled.bucketCapabilities()).versioning).toBe('enabled');

		const suspended = storageWith(
			capabilityFetch(
				() =>
					new Response(
						'<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>',
						{ status: 200 }
					),
				NO_LOCK
			).impl
		);
		expect((await suspended.bucketCapabilities()).versioning).toBe('suspended');
	});

	it('reports object lock on', async () => {
		const storage = storageWith(
			capabilityFetch(
				OFF_VERSIONING,
				() =>
					new Response(
						'<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>',
						{ status: 200 }
					)
			).impl
		);
		expect((await storage.bucketCapabilities()).objectLock).toBe(true);
	});

	it('maps a provider without the API (501) to off, not unknown', async () => {
		const storage = storageWith(
			capabilityFetch(
				() => new Response('<Error><Code>NotImplemented</Code></Error>', { status: 501 }),
				() => new Response('<Error><Code>NotImplemented</Code></Error>', { status: 501 })
			).impl
		);
		await expect(storage.bucketCapabilities()).resolves.toEqual({
			versioning: 'off',
			objectLock: false
		});
	});

	it('fails closed (unknown / null) when the provider refuses', async () => {
		const storage = storageWith(
			capabilityFetch(
				() => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }),
				() => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })
			).impl
		);
		await expect(storage.bucketCapabilities()).resolves.toEqual({
			versioning: 'unknown',
			objectLock: null
		});
	});

	it('surfaces a transport failure so callers can abort', async () => {
		const impl = vi.fn(async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch;
		await expect(storageWith(impl).bucketCapabilities()).rejects.toMatchObject({
			name: 'StorageError',
			status: 0
		});
	});
});

describe('S3Storage addressing', () => {
	it('moves the bucket into the hostname in virtual-host style (AWS/R2)', async () => {
		const { impl, calls } = recordingFetch(() => new Response(null, { status: 200 }));
		const storage = new S3Storage(VHOST_CONFIG, { fetchImpl: impl, clock: FIXED_CLOCK });

		await storage.put('ab/abc.webp', new TextEncoder().encode('x'));

		expect(calls[0].url).toBe('https://web-lair.s3.us-east-1.amazonaws.com/ab/abc.webp');
		const headers = new Headers(calls[0].init.headers);
		expect(headers.get('authorization')).toContain('SignedHeaders=host;x-amz-content-sha256');
		// The signed host is the bucket subdomain, not the bare endpoint.
		const auth = headers.get('authorization') ?? '';
		expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);
	});

	it('signs bucket operations at the virtual-host root', async () => {
		const { impl, calls } = recordingFetch((call) => {
			if (call.init.method === 'HEAD') return new Response(null, { status: 200 });
			return new Response(
				'<VersioningConfiguration></VersioningConfiguration><ObjectLockConfiguration/>',
				{ status: 200 }
			);
		});
		const storage = new S3Storage(VHOST_CONFIG, { fetchImpl: impl, clock: FIXED_CLOCK });

		await storage.headBucket();
		await storage.bucketCapabilities();

		expect(calls[0].url).toBe('https://web-lair.s3.us-east-1.amazonaws.com/');
		expect(calls[1].url).toBe('https://web-lair.s3.us-east-1.amazonaws.com/?versioning=');
		expect(calls[2].url).toBe('https://web-lair.s3.us-east-1.amazonaws.com/?object-lock=');
	});
});

describe('staged read timeouts', () => {
	it('stage 1 aborts a stalled response and surfaces a StorageError', async () => {
		const impl = vi.fn(
			(_input: URL | RequestInfo, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError'))
					);
				})
		) as unknown as typeof fetch;
		const storage = new S3Storage(CONFIG, {
			fetchImpl: impl,
			clock: FIXED_CLOCK,
			headersTimeoutMs: 25
		});

		await expect(storage.head('x')).rejects.toMatchObject({ name: 'StorageError', status: 0 });
	});

	it('a slow but active stream is not killed by the headers budget', async () => {
		const encoder = new TextEncoder();
		const { impl } = recordingFetch(() => {
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					for (let index = 0; index < 5; index += 1) {
						await new Promise((resolve) => setTimeout(resolve, 20));
						controller.enqueue(encoder.encode(`c${index}`));
					}
					controller.close();
				}
			});
			return new Response(stream, {
				status: 200,
				headers: { 'content-type': 'application/octet-stream' }
			});
		});
		const storage = new S3Storage(CONFIG, {
			fetchImpl: impl,
			clock: FIXED_CLOCK,
			headersTimeoutMs: 10,
			bodyIdleTimeoutMs: 5_000
		});

		const object = await storage.get('maps/world.pmtiles');

		await expect(new Response(object!.body).text()).resolves.toBe('c0c1c2c3c4');
	});

	it('stage 2 fails an idle body with a StorageError', async () => {
		const { impl } = recordingFetch(() => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('head'));
					// never closes — the next read hangs until the idle guard fires
				}
			});
			return new Response(stream, { status: 200 });
		});
		const storage = new S3Storage(CONFIG, {
			fetchImpl: impl,
			clock: FIXED_CLOCK,
			bodyIdleTimeoutMs: 40
		});

		const object = await storage.get('maps/x.pmtiles');

		await expect(new Response(object!.body).text()).rejects.toMatchObject({
			name: 'StorageError'
		});
	});

	it('forwards a suffix range as the S3 last-N header', async () => {
		const { impl, calls } = recordingFetch(
			() =>
				new Response('tail', {
					status: 206,
					headers: { 'content-range': 'bytes 252-255/256' }
				})
		);
		const storage = storageWith(impl);

		await storage.get('maps/world.pmtiles', { range: { suffix: 4 } });

		const headers = new Headers(calls[0]!.init.headers);
		expect(headers.get('range')).toBe('bytes=-4');
	});

	it('forwards a byte range unsigned and reports the 206 fields', async () => {
		const { impl, calls } = recordingFetch(
			() =>
				new Response('0123', {
					status: 206,
					headers: {
						'content-length': '4',
						'content-range': 'bytes 0-3/10',
						'content-type': 'application/octet-stream'
					}
				})
		);
		const storage = storageWith(impl);

		const object = await storage.get('maps/world.pmtiles', { range: { start: 0, end: 3 } });

		expect(object?.status).toBe(206);
		expect(object?.contentRange).toBe('bytes 0-3/10');
		expect(calls[0]!.init.method).toBe('GET');
		const headers = new Headers(calls[0]!.init.headers);
		expect(headers.get('range')).toBe('bytes=0-3');
		expect(headers.get('authorization') ?? '').not.toContain('range');
		await expect(new Response(object!.body).text()).resolves.toBe('0123');
	});
});
