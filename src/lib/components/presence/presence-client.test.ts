import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	elementProgress,
	getOrCreatePresenceToken,
	openPresenceStream,
	positionBucket,
	sendPresenceHeartbeat,
	shouldTrackPath,
	startPresenceHeartbeat,
	STREAM_COLD_RETRY_LIMIT,
	STREAM_RETRY_BASE_MS
} from './presence-client';

/**
 * Unit tests for the presence client engine (realtime R3): token tiers
 * (randomUUID → getRandomValues → Math.random, all v4-shaped), the mount
 * filter (R-6), the heartbeat loop (immediate beat / cadence / hidden pause /
 * catch-up), the SSE watchdog (backoff, CONNECTING is the browser's job, the
 * cold-retry cap that keeps a 204-disabled stream quiet) and the position
 * math. DOM and EventSource are injected fakes; timers are fake throughout.
 */

const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function memoryStorage(initial: Record<string, string> = {}) {
	const store = new Map<string, string>(Object.entries(initial));
	return {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		raw: store
	};
}

function fakeDocument(initial: DocumentVisibilityState = 'visible') {
	const listeners = new Map<string, Set<() => void>>();
	return {
		visibilityState: initial,
		addEventListener(type: string, listener: () => void) {
			const set = listeners.get(type) ?? new Set<() => void>();
			set.add(listener);
			listeners.set(type, set);
		},
		removeEventListener(type: string, listener: () => void) {
			listeners.get(type)?.delete(listener);
		},
		fire(type: string) {
			for (const listener of [...(listeners.get(type) ?? [])]) listener();
		},
		listenerCount(type: string) {
			return listeners.get(type)?.size ?? 0;
		}
	};
}

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	readyState = 0;
	closed = false;
	readonly url: string;
	#listeners = new Map<string, ((event: Event) => void)[]>();

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, listener: (event: Event) => void) {
		const list = this.#listeners.get(type) ?? [];
		list.push(listener);
		this.#listeners.set(type, list);
	}
	close() {
		this.closed = true;
		this.readyState = 2;
	}
	emit(type: string, data?: string) {
		const event = data === undefined ? new Event(type) : new MessageEvent(type, { data });
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
	}
	fatal() {
		// The spec's permanent-failure shape: CLOSED + error event.
		this.readyState = 2;
		this.emit('error');
	}
}

describe('shouldTrackPath', () => {
	it('covers public surfaces and excludes /account plus the auth pages (R-6)', () => {
		expect(shouldTrackPath('/')).toBe(true);
		expect(shouldTrackPath('/posts/hello')).toBe(true);
		expect(shouldTrackPath('/notes/topics/travel')).toBe(true);
		expect(shouldTrackPath('/photos')).toBe(true);
		for (const excluded of [
			'/account',
			'/account/security',
			'/login',
			'/register',
			'/forgot-password',
			'/reset-password',
			'/verify-email'
		]) {
			expect(shouldTrackPath(excluded), excluded).toBe(false);
		}
		// Language-prefixed forms (reroute keeps page.url prefixed): the
		// canonicalisation closes the /zh-cn/account bypass (review finding).
		for (const prefixed of [
			'/en/account',
			'/zh-cn/account/security',
			'/zh-cn/login',
			'/ja/register',
			'/en/forgot-password',
			'/zh-cn/reset-password',
			'/ja/verify-email'
		]) {
			expect(shouldTrackPath(prefixed), prefixed).toBe(false);
		}
		expect(shouldTrackPath('/zh-cn/posts/hello')).toBe(true);
		expect(shouldTrackPath('/en/notes/topics/travel')).toBe(true);
	});
});

describe('presence token', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('creates, persists and reuses a v4-shaped token', () => {
		const storage = memoryStorage();
		const token = getOrCreatePresenceToken(storage);
		expect(token).toMatch(V4_RE);
		expect(getOrCreatePresenceToken(storage)).toBe(token);
		expect(storage.raw.get('wl.presence.token')).toBe(token);
	});

	it('replaces a stale stored value that would fail the server uuid gate', () => {
		const storage = memoryStorage({ 'wl.presence.token': 'not-a-uuid' });
		const token = getOrCreatePresenceToken(storage);
		expect(token).not.toBe('not-a-uuid');
		expect(token).toMatch(V4_RE);
		expect(storage.raw.get('wl.presence.token')).toBe(token);
	});

	it('uses getRandomValues (still v4) when randomUUID is unavailable', () => {
		vi.stubGlobal('crypto', {
			getRandomValues: (bytes: Uint8Array) => bytes.fill(0xab)
		});
		const storage = memoryStorage();
		expect(getOrCreatePresenceToken(storage)).toBe('abababab-abab-4bab-abab-abababababab');
	});

	it('prefers crypto.randomUUID when available (tier 1)', () => {
		vi.stubGlobal('crypto', {
			randomUUID: () => '12345678-1234-4123-8123-123456789abc',
			getRandomValues: () => {
				throw new Error('tier 2 must not be reached');
			}
		});
		expect(getOrCreatePresenceToken(memoryStorage())).toBe('12345678-1234-4123-8123-123456789abc');
	});

	it('falls through to Math.random when crypto is gutted', () => {
		vi.stubGlobal('crypto', {});
		expect(getOrCreatePresenceToken(memoryStorage())).toMatch(V4_RE);
	});

	it('survives an unavailable sessionStorage via the in-memory token', () => {
		const broken = {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			}
		};
		const first = getOrCreatePresenceToken(broken);
		expect(first).toMatch(V4_RE);
		expect(getOrCreatePresenceToken(broken)).toBe(first);
	});
});

describe('site heartbeat loop', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('beats immediately, then on cadence; stop() ends it', async () => {
		const doc = fakeDocument();
		const send = vi.fn(async () => {});
		const stop = startPresenceHeartbeat({ token: 't', send, document: doc, intervalMs: 15_000 });
		expect(send).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(send).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(send).toHaveBeenCalledTimes(4);
		stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(send).toHaveBeenCalledTimes(4);
	});

	it('pauses while hidden and returns with a single catch-up beat', async () => {
		const doc = fakeDocument();
		const send = vi.fn(async () => {});
		const stop = startPresenceHeartbeat({ token: 't', send, document: doc, intervalMs: 15_000 });
		expect(send).toHaveBeenCalledTimes(1);
		doc.visibilityState = 'hidden';
		doc.fire('visibilitychange');
		await vi.advanceTimersByTimeAsync(120_000);
		expect(send).toHaveBeenCalledTimes(1);
		doc.visibilityState = 'visible';
		doc.fire('visibilitychange');
		expect(send).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(send).toHaveBeenCalledTimes(3);
		stop();
	});

	it('starts silent when the document is already hidden', async () => {
		const send = vi.fn(async () => {});
		const stop = startPresenceHeartbeat({
			token: 't',
			send,
			document: fakeDocument('hidden'),
			intervalMs: 15_000
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(send).not.toHaveBeenCalled();
		stop();
	});

	it('reads the live context on every beat and removes its listener on stop', async () => {
		const doc = fakeDocument();
		const send = vi.fn(async () => {});
		let bucket = 1;
		const stop = startPresenceHeartbeat({
			token: 't',
			send,
			document: doc,
			intervalMs: 1_000,
			context: () => ({ contentId: 'c-1', bucket })
		});
		expect(send).toHaveBeenLastCalledWith('t', { contentId: 'c-1', bucket: 1 });
		bucket = 2;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(send).toHaveBeenLastCalledWith('t', { contentId: 'c-1', bucket: 2 });
		expect(doc.listenerCount('visibilitychange')).toBe(1);
		stop();
		expect(doc.listenerCount('visibilitychange')).toBe(0);
	});

	it('uses the 15s default cadence when no interval is given', async () => {
		const send = vi.fn(async () => {});
		const stop = startPresenceHeartbeat({ token: 't', send, document: fakeDocument() });
		expect(send).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(send).toHaveBeenCalledTimes(2);
		stop();
	});
});

describe('sendPresenceHeartbeat wire shape', () => {
	it('posts the json contract with keepalive and swallows a network failure', async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		await sendPresenceHeartbeat(
			't',
			{ contentId: 'c', bucket: 3 },
			fetchMock as unknown as typeof fetch
		);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/presence/heartbeat');
		expect(init.method).toBe('POST');
		expect(init.keepalive).toBe(true);
		expect(JSON.parse(String(init.body))).toEqual({ token: 't', c: 'c', bucket: 3 });
		const failing = vi.fn(async () => {
			throw new Error('offline');
		});
		await expect(
			sendPresenceHeartbeat('t', {}, failing as unknown as typeof fetch)
		).resolves.toBeUndefined();
	});
});

describe('presence stream watchdog', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeEventSource.instances = [];
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const ctor = FakeEventSource as unknown as new (url: string) => FakeEventSource;

	it('connects once, forwards parsed snapshots and skips malformed frames', () => {
		const snapshots: unknown[] = [];
		const stop = openPresenceStream({
			url: '/api/presence/stream?c=x',
			onSnapshot: (payload) => snapshots.push(payload),
			eventSource: ctor
		});
		expect(FakeEventSource.instances).toHaveLength(1);
		const source = FakeEventSource.instances[0];
		expect(source.url).toBe('/api/presence/stream?c=x');
		source.emit('open');
		source.emit('snapshot', JSON.stringify({ content: { count: 1, hist: [] } }));
		source.emit('snapshot', 'not json');
		expect(snapshots).toEqual([{ content: { count: 1, hist: [] } }]);
		stop();
		expect(source.closed).toBe(true);
	});

	it('leaves CONNECTING errors to the browser (no rebuild)', async () => {
		const stop = openPresenceStream({ url: 'u', onSnapshot: () => {}, eventSource: ctor });
		FakeEventSource.instances[0].emit('error'); // readyState still CONNECTING
		await vi.advanceTimersByTimeAsync(300_000);
		expect(FakeEventSource.instances).toHaveLength(1);
		stop();
	});

	it('rebuilds after a fatal failure with exponential backoff', async () => {
		const stop = openPresenceStream({ url: 'u', onSnapshot: () => {}, eventSource: ctor });
		const first = FakeEventSource.instances[0];
		first.emit('open');
		first.fatal();
		expect(FakeEventSource.instances).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(STREAM_RETRY_BASE_MS);
		expect(FakeEventSource.instances).toHaveLength(2);
		FakeEventSource.instances[1].fatal();
		await vi.advanceTimersByTimeAsync(STREAM_RETRY_BASE_MS); // 5s: delay is 10s
		expect(FakeEventSource.instances).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(STREAM_RETRY_BASE_MS); // 10s total: rebuilt
		expect(FakeEventSource.instances).toHaveLength(3);
		stop();
	});

	it('resets the backoff after an open (a later hiccup rebuilds fast)', async () => {
		const stop = openPresenceStream({ url: 'u', onSnapshot: () => {}, eventSource: ctor });
		FakeEventSource.instances[0].fatal();
		await vi.advanceTimersByTimeAsync(STREAM_RETRY_BASE_MS);
		expect(FakeEventSource.instances).toHaveLength(2);
		FakeEventSource.instances[1].fatal(); // second cold fatal: delay doubles
		await vi.advanceTimersByTimeAsync(STREAM_RETRY_BASE_MS * 2);
		expect(FakeEventSource.instances).toHaveLength(3);
		FakeEventSource.instances[2].emit('open'); // resets attempt + cold count
		FakeEventSource.instances[2].fatal();
		await vi.advanceTimersByTimeAsync(STREAM_RETRY_BASE_MS); // base delay again
		expect(FakeEventSource.instances).toHaveLength(4);
		stop();
	});

	it('gives up after the cold-retry cap (a 204-disabled stream cannot loop)', async () => {
		const stop = openPresenceStream({ url: 'u', onSnapshot: () => {}, eventSource: ctor });
		for (let round = 0; round <= STREAM_COLD_RETRY_LIMIT; round += 1) {
			FakeEventSource.instances[FakeEventSource.instances.length - 1].fatal();
			await vi.advanceTimersByTimeAsync(60_000);
		}
		expect(FakeEventSource.instances).toHaveLength(STREAM_COLD_RETRY_LIMIT + 1);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(FakeEventSource.instances).toHaveLength(STREAM_COLD_RETRY_LIMIT + 1);
		stop();
	});

	it('caps the backoff at 60s (the 5th cold delay is 60s, not 80s)', async () => {
		const stop = openPresenceStream({ url: 'u', onSnapshot: () => {}, eventSource: ctor });
		// Four cold fatals: delays 5s, 10s, 20s, 40s (literal in/out, so a
		// changed base or a dropped exponent turns this red).
		const delays = [5_000, 10_000, 20_000, 40_000];
		const stillWaiting: number[] = [1, 2, 3, 4];
		for (let round = 0; round < delays.length; round += 1) {
			const current = FakeEventSource.instances[FakeEventSource.instances.length - 1];
			current.fatal();
			await vi.advanceTimersByTimeAsync(delays[round] - 1);
			expect(FakeEventSource.instances).toHaveLength(stillWaiting[round]);
			await vi.advanceTimersByTimeAsync(1);
		}
		expect(FakeEventSource.instances).toHaveLength(5);
		// The 5th delay would be 80s uncapped: 59s must NOT have rebuilt…
		FakeEventSource.instances[4].fatal();
		await vi.advanceTimersByTimeAsync(59_000);
		expect(FakeEventSource.instances).toHaveLength(5);
		// …and by 61s the capped 60s delay has (uncapped would still wait).
		await vi.advanceTimersByTimeAsync(2_000);
		expect(FakeEventSource.instances).toHaveLength(6);
		// The 6th cold fatal crosses the cap: quiet, no further instances.
		FakeEventSource.instances[5].fatal();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(FakeEventSource.instances).toHaveLength(6);
		stop();
	});

	it('stop() cancels a pending rebuild and ignores later errors', async () => {
		const stop = openPresenceStream({ url: 'u', onSnapshot: () => {}, eventSource: ctor });
		const source = FakeEventSource.instances[0];
		source.fatal(); // schedules a rebuild
		stop();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(FakeEventSource.instances).toHaveLength(1);
		expect(source.closed).toBe(true);
		source.emit('error'); // a late event must not resurrect anything
		await vi.advanceTimersByTimeAsync(300_000);
		expect(FakeEventSource.instances).toHaveLength(1);
	});
});

describe('position math', () => {
	it('maps percentages to 20 buckets with clamping', () => {
		expect(positionBucket(0)).toBe(0);
		expect(positionBucket(4.9)).toBe(0);
		expect(positionBucket(5)).toBe(1);
		expect(positionBucket(99.9)).toBe(19);
		expect(positionBucket(100)).toBe(19);
		expect(positionBucket(-3)).toBe(0);
		expect(positionBucket(123)).toBe(19);
	});

	it('reads element progress from the viewport relation', () => {
		expect(elementProgress({ top: 100, height: 1_000 }, 700)).toBeCloseTo(60);
		expect(elementProgress({ top: 800, height: 1_000 }, 700)).toBe(0);
		expect(elementProgress({ top: -400, height: 1_000 }, 700)).toBe(100);
		expect(elementProgress({ top: 0, height: 0 }, 700)).toBe(100);
	});
});
