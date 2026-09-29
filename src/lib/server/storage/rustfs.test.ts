import { describe, expect, it, vi } from 'vitest';
import { storageConfigFromEnv } from './config';
import { RustFsStorage } from './rustfs';
import { sha256Hex } from './signature';

const CONFIG = storageConfigFromEnv({
	RUSTFS_ENDPOINT: 'http://127.0.0.1:9000/',
	RUSTFS_ACCESS_KEY: 'test-key',
	RUSTFS_SECRET_KEY: 'test-secret',
	RUSTFS_BUCKET: 'web-lair'
});

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

function storageWith(impl: typeof fetch): RustFsStorage {
	return new RustFsStorage(CONFIG, { fetchImpl: impl, clock: FIXED_CLOCK });
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
	});
});

describe('RustFsStorage', () => {
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
			/^AWS4-HMAC-SHA256 Credential=test-key\/20260929\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/
		);
		expect(new TextDecoder().decode(call.init.body as Uint8Array)).toBe('hello');
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
});
