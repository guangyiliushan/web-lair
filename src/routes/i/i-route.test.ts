import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
	get: vi.fn(),
	head: vi.fn()
}));
const dbMock = vi.hoisted(() => ({
	select: vi.fn()
}));

vi.mock('$lib/server/storage', () => ({ getStorage: () => storageMock }));
vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/db/content', () => ({
	files: { id: 'files.id', objectKey: 'files.objectKey' }
}));

import { GET, HEAD } from './[...key]/+server';

/** sha256-shaped key whose directory equals the first two hex chars. */
const SHA = 'ab' + 'c'.repeat(62);
const VARIANT_KEY = `${SHA.slice(0, 2)}/${SHA}.jpg@thumb`;
const PREVIEW_KEY = `${SHA.slice(0, 2)}/${SHA}.jpg@preview`;
const FULL_VARIANT_KEY = `${SHA.slice(0, 2)}/${SHA}.jpg@full`;
const ORIGINAL_KEY = `${SHA.slice(0, 2)}/${SHA}.jpg`;
const GIF_KEY = `${SHA.slice(0, 2)}/${SHA}.gif`;
const DOC_KEY = `${SHA.slice(0, 2)}/${SHA}.pdf`;
const ADMIN_LOCALS = { admin: { userId: 'admin-1', role: 'owner' } };

/** Chain satisfying db.select().from().where().limit(1) → rows. */
function registryChain(rows: unknown[]) {
	const chain: Record<string, unknown> = {};
	chain.from = vi.fn(() => chain);
	chain.where = vi.fn(() => chain);
	chain.limit = vi.fn(async () => rows);
	return chain;
}

function event(key: string, locals: unknown = {}) {
	return { params: { key }, locals } as unknown as Parameters<typeof GET>[0];
}

function bodyOf(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body!;
}

beforeEach(() => {
	storageMock.get.mockReset();
	storageMock.head.mockReset();
	dbMock.select.mockReset();
});

describe('/i/<key> proxy (T9)', () => {
	it('serves variant keys publicly with immutable caching + nosniff', async () => {
		storageMock.get.mockResolvedValueOnce({
			body: bodyOf('img'),
			byteSize: 3,
			contentType: 'image/webp'
		});

		const res = await GET(event(VARIANT_KEY));

		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('content-length')).toBe('3');
		expect(res.headers.get('content-type')).toBe('image/webp');
		expect(await res.text()).toBe('img');
		expect(storageMock.get).toHaveBeenCalledWith(VARIANT_KEY);
	});

	it('serves every variant kind (@thumb/@preview/@full) under the same policy', async () => {
		for (const key of [VARIANT_KEY, PREVIEW_KEY, FULL_VARIANT_KEY]) {
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
		expect(dbMock.select).not.toHaveBeenCalled();
	});

	it('hides photo originals from anonymous requests (no storage or registry probe)', async () => {
		await expect(GET(event(ORIGINAL_KEY))).rejects.toMatchObject({ status: 404 });
		await expect(HEAD(event(ORIGINAL_KEY))).rejects.toMatchObject({ status: 404 });
		expect(storageMock.get).not.toHaveBeenCalled();
		expect(storageMock.head).not.toHaveBeenCalled();
		expect(dbMock.select).not.toHaveBeenCalled();
	});

	it('serves photo originals to admins with private caching', async () => {
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

	it('serves GIF originals publicly as the pass-through tier (plan §4.3)', async () => {
		storageMock.get.mockResolvedValueOnce({
			body: bodyOf('gif'),
			byteSize: 3,
			contentType: 'image/gif'
		});

		const res = await GET(event(GIF_KEY));

		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toContain('immutable');
		expect(res.headers.get('content-type')).toBe('image/gif');
		expect(dbMock.select).not.toHaveBeenCalled();
	});

	it('serves registered attachments publicly as nosniff downloads', async () => {
		dbMock.select.mockReturnValueOnce(registryChain([{ id: 'file-1' }]));
		storageMock.get.mockResolvedValueOnce({
			body: bodyOf('%PDF-1.7'),
			byteSize: 8,
			contentType: 'application/pdf'
		});

		const res = await GET(event(DOC_KEY));

		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toContain('immutable');
		expect(res.headers.get('content-disposition')).toBe('attachment');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(dbMock.select).toHaveBeenCalledTimes(1);
	});

	it('404s unregistered attachments without touching storage', async () => {
		dbMock.select.mockReturnValue(registryChain([]));

		await expect(GET(event(DOC_KEY))).rejects.toMatchObject({ status: 404 });
		await expect(HEAD(event(DOC_KEY))).rejects.toMatchObject({ status: 404 });
		expect(storageMock.get).not.toHaveBeenCalled();
		expect(storageMock.head).not.toHaveBeenCalled();
	});

	it('lets admins fetch attachments even when unregistered (attachment, private)', async () => {
		storageMock.get.mockResolvedValueOnce({
			body: bodyOf('%PDF'),
			byteSize: 4,
			contentType: 'application/pdf'
		});

		const res = await GET(event(DOC_KEY, ADMIN_LOCALS));

		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('private, no-store');
		expect(res.headers.get('content-disposition')).toBe('attachment');
		expect(dbMock.select).not.toHaveBeenCalled();
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
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('HEAD maps missing objects to 404', async () => {
		storageMock.head.mockResolvedValueOnce(null);
		await expect(HEAD(event(VARIANT_KEY))).rejects.toMatchObject({ status: 404 });
	});
});
