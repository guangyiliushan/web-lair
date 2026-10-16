import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '$lib/server/cache/memory';
import { dateStamp } from '$lib/server/services/presence';

/**
 * Route tests for the presence SSE stream (realtime R2, ledger §23): the
 * always-200 contract (degradation happens inside the payload — WHATWG makes
 * any non-200 a permanent EventSource failure), the one deliberate 204
 * (presence disabled = stop reconnecting), the scoping guards, the payload
 * shapes for the three viewer classes, the immediate first frame, the 5s
 * cadence with the 15s keepalive and the abort cleanup. The REAL presence
 * service runs against a MemoryCacheStore, so the shapes exercised here are
 * the production ones.
 */
const { state } = vi.hoisted(() => ({
	state: {
		enabled: true,
		readerDots: false,
		store: null as unknown
	}
}));

vi.mock('$lib/server/cache', () => ({ getCache: () => state.store }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async (key: string) =>
		key === 'presence.enabled'
			? state.enabled
			: key === 'presence.readerDots'
				? state.readerDots
				: 'UTC'
	)
}));

import { GET, PRESENCE_SNAPSHOT_MS } from './+server';

const TOKEN_A = '6f3a2b9c-0d4e-4c8a-9b1f-2f9c4d7e8a11';
const TOKEN_B = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const CONTENT = '0d9e4b2a-7c31-4f5e-8a6b-1c2d3e4f5a6b';

function histogram(...entries: [number, number][]): number[] {
	const hist = new Array<number>(20).fill(0);
	for (const [index, count] of entries) hist[index] = count;
	return hist;
}

function requestStream(params: { c?: string; admin?: boolean; signal: AbortSignal }) {
	const url = new URL('http://localhost/api/presence/stream');
	if (params.c !== undefined) url.searchParams.set('c', params.c);
	return GET({
		url,
		request: new Request(url, { signal: params.signal }),
		locals: {
			admin: params.admin ? { userId: 'u-owner', role: 'owner' } : null,
			user: null
		}
	} as never);
}

async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	predicate: (text: string) => boolean,
	timeoutMs = 3000
): Promise<string> {
	const decoder = new TextDecoder();
	let text = '';
	const deadline = Date.now() + timeoutMs;
	for (let reads = 0; reads < 12 && Date.now() <= deadline; reads += 1) {
		const chunk = await reader.read();
		if (chunk.done) break;
		text += decoder.decode(chunk.value, { stream: true });
		if (predicate(text)) break;
	}
	return text;
}

function snapshotPayload(text: string): unknown {
	const line = text.split('\n').find((candidate) => candidate.startsWith('data: '));
	expect(line, `no data line in: ${JSON.stringify(text)}`).toBeDefined();
	return JSON.parse((line as string).slice('data: '.length));
}

describe('presence stream route', () => {
	beforeEach(() => {
		state.enabled = true;
		state.readerDots = false;
		state.store = new MemoryCacheStore();
	});

	it('answers 204 when presence is disabled (the stop-reconnect signal)', async () => {
		state.enabled = false;
		const ac = new AbortController();
		const response = await requestStream({ c: CONTENT, signal: ac.signal });
		expect(response.status).toBe(204);
		expect(response.body).toBeNull();
	});

	it('rejects a malformed content id and a reader stream without ?c', async () => {
		const ac = new AbortController();
		expect((await requestStream({ c: 'doc', signal: ac.signal })).status).toBe(400);
		expect((await requestStream({ signal: ac.signal })).status).toBe(400);
	});

	it('streams the reader content slice: headers, retry preamble, first frame, no dots/site/id', async () => {
		const store = state.store as MemoryCacheStore;
		const nowSec = Math.floor(Date.now() / 1000);
		await store.zadd(`presence:c:${CONTENT}`, `3:${TOKEN_A}`, nowSec);
		const ac = new AbortController();
		const response = await requestStream({ c: CONTENT, signal: ac.signal });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')?.startsWith('text/event-stream')).toBe(true);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('x-accel-buffering')).toBe('no');
		const text = await readUntil(
			(response.body as ReadableStream<Uint8Array>).getReader(),
			(candidate) => candidate.includes('event: snapshot')
		);
		expect(text).toContain('retry: 5000');
		expect(text).not.toMatch(/^id:/m);
		expect(snapshotPayload(text)).toEqual({ content: { count: 1, hist: histogram([3, 1]) } });
		ac.abort();
	});

	it('adds anonymous position dots for admins on a content page', async () => {
		const store = state.store as MemoryCacheStore;
		const nowSec = Math.floor(Date.now() / 1000);
		await store.zadd(`presence:c:${CONTENT}`, `3:${TOKEN_A}`, nowSec);
		await store.zadd(`presence:c:${CONTENT}`, `11:${TOKEN_B}`, nowSec - 5);
		const ac = new AbortController();
		const response = await requestStream({ c: CONTENT, admin: true, signal: ac.signal });
		const text = await readUntil(
			(response.body as ReadableStream<Uint8Array>).getReader(),
			(candidate) => candidate.includes('event: snapshot')
		);
		expect(snapshotPayload(text)).toEqual({
			content: { count: 2, hist: histogram([3, 1], [11, 1]) },
			// Dots follow the zrange order: ascending by last-seen.
			dots: [11, 3]
		});
		ac.abort();
	});

	it('adds anonymous dots for readers when presence.readerDots is on', async () => {
		state.readerDots = true;
		const store = state.store as MemoryCacheStore;
		const nowSec = Math.floor(Date.now() / 1000);
		await store.zadd(`presence:c:${CONTENT}`, `3:${TOKEN_A}`, nowSec);
		const ac = new AbortController();
		const response = await requestStream({ c: CONTENT, signal: ac.signal });
		const text = await readUntil(
			(response.body as ReadableStream<Uint8Array>).getReader(),
			(candidate) => candidate.includes('event: snapshot')
		);
		expect(snapshotPayload(text)).toEqual({
			content: { count: 1, hist: histogram([3, 1]) },
			dots: [3]
		});
		ac.abort();
	});

	it('streams site/day/peak for the admin dashboard (no ?c)', async () => {
		const store = state.store as MemoryCacheStore;
		const nowSec = Math.floor(Date.now() / 1000);
		const date = dateStamp(Date.now(), 'UTC');
		await store.zadd('presence:site', TOKEN_A, nowSec);
		await store.zadd('presence:site', TOKEN_B, nowSec - 10);
		await store.sadd(`presence:day:${date}`, TOKEN_A);
		await store.zadd(`presence:max:${date}`, '2', 2);
		const ac = new AbortController();
		const response = await requestStream({ admin: true, signal: ac.signal });
		const text = await readUntil(
			(response.body as ReadableStream<Uint8Array>).getReader(),
			(candidate) => candidate.includes('event: snapshot')
		);
		expect(snapshotPayload(text)).toEqual({ site: 2, day: 1, peak: 2 });
		ac.abort();
	});

	it('degrades to null fields with a 200 when the cache is down', async () => {
		const boom = async (): Promise<never> => {
			throw new Error('cache down');
		};
		state.store = {
			get: boom,
			set: boom,
			incr: boom,
			zadd: boom,
			ztrim: boom,
			zcountAbove: boom,
			zrangeAbove: boom,
			sadd: boom,
			scard: boom,
			expire: boom
		};
		const ac = new AbortController();
		const readerResponse = await requestStream({ c: CONTENT, signal: ac.signal });
		expect(readerResponse.status).toBe(200);
		const readerText = await readUntil(
			(readerResponse.body as ReadableStream<Uint8Array>).getReader(),
			(candidate) => candidate.includes('event: snapshot')
		);
		expect(snapshotPayload(readerText)).toEqual({ content: null });
		ac.abort();
		const adminAc = new AbortController();
		const adminResponse = await requestStream({ admin: true, signal: adminAc.signal });
		const adminText = await readUntil(
			(adminResponse.body as ReadableStream<Uint8Array>).getReader(),
			(candidate) => candidate.includes('event: snapshot')
		);
		expect(snapshotPayload(adminText)).toEqual({ site: null, day: null, peak: null });
		adminAc.abort();
	});

	it('ticks a snapshot every 5s, a keepalive every 15s, and aborts clean', async () => {
		vi.useFakeTimers();
		try {
			const ac = new AbortController();
			const response = await requestStream({ c: CONTENT, signal: ac.signal });
			const reader = (response.body as ReadableStream<Uint8Array>).getReader();
			expect(await readUntil(reader, (text) => text.includes('event: snapshot'))).toContain(
				'retry: 5000'
			);
			expect(vi.getTimerCount()).toBe(1); // the tick interval
			await vi.advanceTimersByTimeAsync(PRESENCE_SNAPSHOT_MS);
			expect(await readUntil(reader, (text) => text.includes('event: snapshot'))).toContain(
				'event: snapshot'
			);
			await vi.advanceTimersByTimeAsync(PRESENCE_SNAPSHOT_MS * 2);
			expect(await readUntil(reader, (text) => text.includes(': keepalive'))).toContain(
				': keepalive'
			);
			ac.abort();
			expect(vi.getTimerCount()).toBe(0);
			// The third tick queued a keepalive + a snapshot; read through the
			// leftovers until the closed stream reports done.
			let done = false;
			for (let reads = 0; reads < 5 && !done; reads += 1) {
				done = (await reader.read()).done;
			}
			expect(done).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
