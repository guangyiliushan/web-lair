import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the PMTiles service route (plan §8, T12): single
 * ranges pass through with the storage's 206 fields mirrored, non-single /
 * malformed / precision-losing ranges fall back to a full 200, unsatisfiable
 * ranges answer a local 416 with Content-Range, the name whitelist blocks
 * traversal and foreign keys, and storage misses answer a plain uncached 404.
 */
const { storage } = vi.hoisted(() => ({
	storage: { get: vi.fn(), head: vi.fn() }
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

	it('accepts the range unit case-insensitively (RFC 9110 tokens)', async () => {
		storage.get.mockResolvedValue({
			body: bodyStream('0123'),
			byteSize: 4,
			contentType: null,
			etag: null,
			contentRange: 'bytes 0-3/10',
			status: 206
		});

		const response = await GET(makeEvent('w.pmtiles', 'BYTES=0-3'));

		expect(storage.get).toHaveBeenCalledWith('maps/w.pmtiles', {
			range: { start: 0, end: 3 }
		});
		expect(response.status).toBe(206);
	});

	it('falls back to the full object for multi-range, malformed and precision-losing ranges', async () => {
		storage.get.mockResolvedValue({
			body: bodyStream('x'),
			byteSize: 1,
			contentType: null,
			etag: null,
			contentRange: null,
			status: 200
		});

		const headers = [
			'bytes=0-3,6-9',
			'bytes=abc',
			'items=0-3',
			// Beyond-2^53 digit strings would lose precision and be
			// re-serialised as `1e+23` into the forwarded header.
			'bytes=100000000000000000000000-',
			'bytes=-99999999999999999999'
		];
		for (const header of headers) {
			await GET(makeEvent('w.pmtiles', header));
		}
		expect(storage.get).toHaveBeenCalledTimes(headers.length);
		for (const call of storage.get.mock.calls) {
			expect(call[1]).toBeUndefined();
		}
	});

	it('answers a local 416 with Content-Range for unsatisfiable ranges', async () => {
		storage.head.mockResolvedValue({ byteSize: 256, contentType: null, etag: null });

		for (const header of ['bytes=-0', 'bytes=5-2']) {
			const response = await GET(makeEvent('w.pmtiles', header));
			expect(response.status).toBe(416);
			expect(response.headers.get('content-range')).toBe('bytes */256');
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
		// Unsatisfiable ranges never reach the storage read path.
		expect(storage.get).not.toHaveBeenCalled();
	});

	it('404s on names outside the whitelist without touching storage', async () => {
		for (const file of ['nope.txt', '../secret.pmtiles', 'a/b.pmtiles', '.pmtiles', '']) {
			await expect(GET(makeEvent(file))).rejects.toMatchObject({ status: 404 });
		}
		expect(storage.get).not.toHaveBeenCalled();
	});

	it('404s a missing object with a plain uncached response', async () => {
		storage.get.mockResolvedValue(null);

		const response = await GET(makeEvent('missing.pmtiles'));

		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('maps a storage 416 to a local 416 (Content-Range when the size is known)', async () => {
		const { StorageError } = await import('$lib/server/storage/port');
		storage.get.mockRejectedValue(new StorageError('range', 416, 'InvalidRange'));
		storage.head.mockResolvedValue({ byteSize: 256, contentType: null, etag: null });

		const response = await GET(makeEvent('w.pmtiles', 'bytes=999-'));

		expect(response.status).toBe(416);
		expect(response.headers.get('content-range')).toBe('bytes */256');
		expect(response.headers.get('cache-control')).toBe('no-store');
	});
});
