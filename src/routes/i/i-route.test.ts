import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
	get: vi.fn(),
	head: vi.fn()
}));

vi.mock('$lib/server/storage', () => ({ getStorage: () => storageMock }));

import { GET, HEAD } from './[...key]/+server';

/** sha256-shaped key whose directory equals the first two hex chars. */
const SHA = 'ab' + 'c'.repeat(62);
const VARIANT_KEY = `${SHA.slice(0, 2)}/${SHA}.jpg@thumb`;
const FULL_VARIANT_KEY = `${SHA.slice(0, 2)}/${SHA}.jpg@full`;
const ORIGINAL_KEY = `${SHA.slice(0, 2)}/${SHA}.jpg`;
const ADMIN_LOCALS = { admin: { userId: 'admin-1', role: 'owner' } };

function event(key: string, locals: unknown = {}) {
	return { params: { key }, locals } as unknown as Parameters<typeof GET>[0];
}

function bodyOf(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body!;
}

beforeEach(() => {
	storageMock.get.mockReset();
	storageMock.head.mockReset();
});

describe('/i/<key> proxy (T9)', () => {
	it('serves variant keys publicly with immutable caching', async () => {
		storageMock.get.mockResolvedValueOnce({
			body: bodyOf('img'),
			byteSize: 3,
			contentType: 'image/webp'
		});

		const res = await GET(event(VARIANT_KEY));

		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(res.headers.get('content-length')).toBe('3');
		expect(res.headers.get('content-type')).toBe('image/webp');
		expect(await res.text()).toBe('img');
		expect(storageMock.get).toHaveBeenCalledWith(VARIANT_KEY);
	});

	it('serves every variant kind (@thumb/@preview/@full) under the same policy', async () => {
		for (const key of [VARIANT_KEY, FULL_VARIANT_KEY]) {
			storageMock.get.mockResolvedValueOnce({
				body: bodyOf('x'),
				byteSize: 1,
				contentType: 'image/webp'
			});
			const res = await GET(event(key));
			expect(res.status).toBe(200);
			expect(res.headers.get('cache-control')).toContain('immutable');
		}
	});

	it('rejects malformed keys with 404 without touching storage', async () => {
		for (const key of [
			'not-a-key',
			'../../etc/passwd',
			`${SHA.slice(0, 2)}/${SHA}`.replace(/^ab/, 'ba'), // directory does not match the digest
			`${SHA.slice(0, 2)}/${SHA}.jpg@bogus`,
			`${SHA.slice(0, 2)}/${SHA.toUpperCase()}.jpg`
		]) {
			await expect(GET(event(key))).rejects.toMatchObject({ status: 404 });
		}
		expect(storageMock.get).not.toHaveBeenCalled();
	});

	it('hides originals from anonymous requests (no storage probe)', async () => {
		await expect(GET(event(ORIGINAL_KEY))).rejects.toMatchObject({ status: 404 });
		await expect(HEAD(event(ORIGINAL_KEY))).rejects.toMatchObject({ status: 404 });
		expect(storageMock.get).not.toHaveBeenCalled();
		expect(storageMock.head).not.toHaveBeenCalled();
	});

	it('serves originals to admins with private caching', async () => {
		storageMock.get.mockResolvedValueOnce({
			body: bodyOf('orig'),
			byteSize: 4,
			contentType: 'image/jpeg'
		});

		const res = await GET(event(ORIGINAL_KEY, ADMIN_LOCALS));

		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('private, no-store');
		expect(await res.text()).toBe('orig');
	});

	it('maps missing objects to 404', async () => {
		storageMock.get.mockResolvedValueOnce(null);
		await expect(GET(event(VARIANT_KEY))).rejects.toMatchObject({ status: 404 });
	});

	it('HEAD returns headers only (no body)', async () => {
		storageMock.head.mockResolvedValueOnce({
			key: VARIANT_KEY,
			byteSize: 10,
			contentType: 'image/webp',
			etag: '"e"'
		});

		const res = await HEAD(event(VARIANT_KEY));

		expect(res.status).toBe(200);
		expect(res.body).toBeNull();
		expect(res.headers.get('content-length')).toBe('10');
		expect(res.headers.get('content-type')).toBe('image/webp');
		expect(res.headers.get('etag')).toBe('"e"');
		expect(res.headers.get('cache-control')).toContain('immutable');
	});

	it('HEAD maps missing objects to 404', async () => {
		storageMock.head.mockResolvedValueOnce(null);
		await expect(HEAD(event(VARIANT_KEY))).rejects.toMatchObject({ status: 404 });
	});
});
