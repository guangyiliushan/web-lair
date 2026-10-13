import { describe, expect, it, vi } from 'vitest';
import {
	FULL_AUTO_LIMIT_BYTES,
	isMeteredConnection,
	shouldLoadFullOnDemand,
	streamImageBytes
} from './viewer-load';

/** T16 policy branches (plan §4.5): threshold / saveData / 2G-class / unknown. */
describe('viewer-load policy', () => {
	it('locks the 8 MB threshold', () => {
		expect(FULL_AUTO_LIMIT_BYTES).toBe(8 * 1024 * 1024);
	});

	it('auto-loads at or below the threshold, on-demand above it', () => {
		expect(shouldLoadFullOnDemand(FULL_AUTO_LIMIT_BYTES, null)).toBe(false);
		expect(shouldLoadFullOnDemand(FULL_AUTO_LIMIT_BYTES + 1, null)).toBe(true);
		expect(shouldLoadFullOnDemand(1200, null)).toBe(false);
		expect(shouldLoadFullOnDemand(9_000_000, null)).toBe(true);
	});

	it('takes the auto path for unknown or non-finite sizes', () => {
		expect(shouldLoadFullOnDemand(null, null)).toBe(false);
		expect(shouldLoadFullOnDemand(Number.NaN, null)).toBe(false);
	});

	it('data-saver forces on-demand regardless of size', () => {
		expect(shouldLoadFullOnDemand(1200, { saveData: true })).toBe(true);
		expect(shouldLoadFullOnDemand(null, { saveData: true })).toBe(true);
		expect(isMeteredConnection({ saveData: true })).toBe(true);
	});

	it('2G-class effective types count as metered; 4G does not', () => {
		expect(isMeteredConnection({ effectiveType: 'slow-2g' })).toBe(true);
		expect(isMeteredConnection({ effectiveType: '2g' })).toBe(true);
		expect(isMeteredConnection({ effectiveType: '3g' })).toBe(false);
		expect(isMeteredConnection({ effectiveType: '4g' })).toBe(false);
		expect(isMeteredConnection({})).toBe(false);
		expect(isMeteredConnection(undefined)).toBe(false);
		expect(isMeteredConnection(null)).toBe(false);
	});
});

describe('streamImageBytes (3c)', () => {
	function responseWith(body: Uint8Array[], headers: Record<string, string> = {}): Response {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of body) controller.enqueue(chunk);
				controller.close();
			}
		});
		return new Response(stream, { headers });
	}

	it('reports byte progress and resolves the full blob', async () => {
		const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => responseWith(chunks, { 'content-length': '5' }))
		);
		const progress: { loaded: number; total: number | null }[] = [];
		try {
			const blob = await streamImageBytes('/i/x@full', {
				signal: new AbortController().signal,
				onProgress: (p) => progress.push({ ...p })
			});
			expect(blob.size).toBe(5);
			expect(progress.map((p) => p.loaded)).toEqual([3, 5]);
			expect(progress.every((p) => p.total === 5)).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('falls back to the registry size when Content-Length is missing', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => responseWith([new Uint8Array([9])]))
		);
		const progress: { loaded: number; total: number | null }[] = [];
		try {
			await streamImageBytes('/i/x@full', {
				signal: new AbortController().signal,
				fallbackTotal: 1234,
				onProgress: (p) => progress.push({ ...p })
			});
			expect(progress[0]?.total).toBe(1234);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('throws on a non-2xx response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('nope', { status: 404 }))
		);
		try {
			await expect(
				streamImageBytes('/i/missing@full', { signal: new AbortController().signal })
			).rejects.toThrow('image 404');
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('propagates abort through the underlying fetch', async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError'))
					);
				});
			})
		);
		try {
			const pending = streamImageBytes('/i/x@full', { signal: controller.signal });
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
