import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the PMTiles service route (plan §8, T12): single
 * ranges pass through with the storage's 206 fields mirrored, non-single
 * ranges fall back to a full 200, the name whitelist blocks traversal and
 * foreign keys, 404s and the 416 mapping behave.
 */
const { storage } = vi.hoisted(() => ({
	storage: { get: vi.fn() }
}));

vi.mock('$lib/server/storage', () => ({
	getStorage: () => storage
}));

import { GET } from './[file]/+server';

function bodyStream(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body!;
}

function makeEvent(file: string, range?: string) {
	return {
		params: { file },
		request: new Request('http://localhost/maps/x.pmtiles', {
			headers: range ? { range } : {}
		})
	} as never;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('GET /maps/[file]', () => {
	it('serves the full object at 200 with the cache and range headers', async () => {
		storage.get.mockResolvedValue({
			body: bodyStream('0123456789'),
			byteSize: 10,
			contentType: 'application/vnd.pmtiles',
			etag: '"e1"',
			contentRange: null,
			status: 200
		});

		const response = await GET(makeEvent('world-z0-6.pmtiles'));

		expect(storage.get).toHaveBeenCalledWith('maps/world-z0-6.pmtiles', undefined);
		expect(response.status).toBe(200);
		expect(response.headers.get('accept-ranges')).toBe('bytes');
		expect(response.headers.get('content-type')).toBe('application/vnd.pmtiles');
		expect(response.headers.get('etag')).toBe('"e1"');
		expect(response.headers.get('content-length')).toBe('10');
		await expect(response.text()).resolves.toBe('0123456789');
	});

	it('forwards a single range and mirrors the 206 fields', async () => {
		storage.get.mockResolvedValue({
			body: bodyStream('0123'),
			byteSize: 4,
			contentType: 'application/vnd.pmtiles',
			etag: null,
			contentRange: 'bytes 0-3/10',
			status: 206
		});

		const response = await GET(makeEvent('world-z0-6.pmtiles', 'bytes=0-3'));

		expect(storage.get).toHaveBeenCalledWith('maps/world-z0-6.pmtiles', {
			range: { start: 0, end: 3 }
		});
		expect(response.status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 0-3/10');
		await expect(response.text()).resolves.toBe('0123');
	});

	it('forwards an open-ended range', async () => {
		storage.get.mockResolvedValue({
			body: bodyStream('456789'),
			byteSize: 6,
			contentType: null,
			etag: null,
			contentRange: 'bytes 4-9/10',
			status: 206
		});

		const response = await GET(makeEvent('w.pmtiles', 'bytes=4-'));

		expect(storage.get).toHaveBeenCalledWith('maps/w.pmtiles', {
			range: { start: 4, end: undefined }
		});
		expect(response.status).toBe(206);
	});

	it('forwards a suffix range (last N bytes)', async () => {
		storage.get.mockResolvedValue({
			body: bodyStream('tail'),
			byteSize: 4,
			contentType: null,
			etag: null,
			contentRange: 'bytes 252-255/256',
			status: 206
		});

		const response = await GET(makeEvent('w.pmtiles', 'bytes=-4'));

		expect(storage.get).toHaveBeenCalledWith('maps/w.pmtiles', { range: { suffix: 4 } });
		expect(response.status).toBe(206);
	});

	it('falls back to the full object for multi-range and malformed ranges', async () => {
		storage.get.mockResolvedValue({
			body: bodyStream('x'),
			byteSize: 1,
			contentType: null,
			etag: null,
			contentRange: null,
			status: 200
		});

		for (const header of ['bytes=0-3,6-9', 'bytes=abc', 'items=0-3']) {
			await GET(makeEvent('w.pmtiles', header));
		}
		expect(storage.get).toHaveBeenCalledTimes(3);
		for (const call of storage.get.mock.calls) {
			expect(call[1]).toBeUndefined();
		}
	});

	it('404s on names outside the whitelist without touching storage', async () => {
		for (const file of ['nope.txt', '../secret.pmtiles', 'a/b.pmtiles', '.pmtiles', '']) {
			await expect(GET(makeEvent(file))).rejects.toMatchObject({ status: 404 });
		}
		expect(storage.get).not.toHaveBeenCalled();
	});

	it('404s a missing object', async () => {
		storage.get.mockResolvedValue(null);
		await expect(GET(makeEvent('missing.pmtiles'))).rejects.toMatchObject({ status: 404 });
	});

	it('maps a storage 416 to a 416 response', async () => {
		const { StorageError } = await import('$lib/server/storage/port');
		storage.get.mockRejectedValue(new StorageError('range', 416, 'InvalidRange'));
		await expect(GET(makeEvent('w.pmtiles', 'bytes=999-'))).rejects.toMatchObject({
			status: 416
		});
	});
});
