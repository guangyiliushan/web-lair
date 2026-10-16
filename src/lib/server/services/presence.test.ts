import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '$lib/server/cache/memory';
import type { CacheStore } from '$lib/server/cache/store';
import {
	dateStamp,
	PRESENCE_BUCKETS,
	PRESENCE_DOTS_LIMIT,
	readContentDots,
	readContentPresence,
	readSitePresence,
	touchPresence
} from './presence';

// The default timezone path reads `site.timezone`; pin it so the rollover
// test can tell the configured zone apart from a hardcoded UTC fallback.
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => 'Asia/Tokyo')
}));
// The process-wide cache resolves lazily; every test below passes an explicit
// store, so this factory only fires in the getCache-failure describe (the
// service must swallow a malformed VALKEY_URL there, review finding).
vi.mock('$lib/server/cache', () => ({
	getCache: () => {
		throw new Error('malformed VALKEY_URL');
	}
}));

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0); // 2026-10-16T12:00:00Z

function histogramWith(counts: Record<number, number>): number[] {
	const histogram = new Array<number>(PRESENCE_BUCKETS).fill(0);
	for (const [bucket, count] of Object.entries(counts)) histogram[Number(bucket)] = count;
	return histogram;
}

function throwingStore(): CacheStore {
	const boom = async (): Promise<never> => {
		throw new Error('cache down');
	};
	return {
		get: vi.fn(boom),
		set: vi.fn(boom),
		incr: vi.fn(boom),
		zadd: vi.fn(boom),
		ztrim: vi.fn(boom),
		zcountAbove: vi.fn(boom),
		zrangeAbove: vi.fn(boom),
		sadd: vi.fn(boom),
		scard: vi.fn(boom),
		expire: vi.fn(boom)
	};
}

describe('dateStamp', () => {
	it('renders YYYY-MM-DD in the requested zone', () => {
		expect(dateStamp(T0, 'UTC')).toBe('2026-10-16');
		expect(dateStamp(Date.UTC(2026, 9, 16, 16), 'UTC')).toBe('2026-10-16');
		expect(dateStamp(Date.UTC(2026, 9, 16, 16), 'Asia/Tokyo')).toBe('2026-10-17');
	});

	it('falls back to UTC for an invalid zone instead of throwing', () => {
		expect(dateStamp(T0, 'Not/AZone')).toBe('2026-10-16');
	});
});

describe('presence service (site / content / day / peak)', () => {
	it('tracks live tabs, day uniques, the peak and content buckets through a window', async () => {
		let now = T0;
		const store = new MemoryCacheStore({ clock: () => now });
		const deps = { store, now: () => now, timezone: 'UTC' };
		await touchPresence({ token: 'tok-a' }, deps);
		expect(await readSitePresence(deps)).toEqual({ site: 1, day: 1, peak: 1 });
		now += 15_000;
		await touchPresence({ token: 'tok-b', contentId: 'doc', bucket: 3 }, deps);
		expect(await readSitePresence(deps)).toEqual({ site: 2, day: 2, peak: 2 });
		expect(await readContentPresence('doc', deps)).toEqual({
			count: 1,
			histogram: histogramWith({ 3: 1 })
		});
		now += 15_000;
		await touchPresence({ token: 'tok-a', contentId: 'doc', bucket: 7 }, deps);
		expect(await readContentPresence('doc', deps)).toEqual({
			count: 2,
			histogram: histogramWith({ 3: 1, 7: 1 })
		});
		expect(await readContentDots('doc', deps)).toEqual([3, 7]);
		now += 31_000; // t+61s: both beats still inside the 60s window
		expect(await readSitePresence(deps)).toEqual({ site: 2, day: 2, peak: 2 });
		now += 15_000; // t+76s: tok-b's t+15s beat is 61s old
		expect(await readSitePresence(deps)).toEqual({ site: 1, day: 2, peak: 2 });
		now += 15_000; // t+91s: tok-a's t+30s beat is 61s old
		expect(await readSitePresence(deps)).toEqual({ site: 0, day: 2, peak: 2 });
	});

	it('never counts members scored before the cutoff (ghost-count regression)', async () => {
		const store = new MemoryCacheStore();
		const deps = { store, now: () => T0, timezone: 'UTC' };
		const staleSec = Math.floor(T0 / 1000) - 120;
		// Seed directly WITHOUT a trim — exactly the state a stopped writer
		// leaves behind; a raw-cardinality read would report 1 for both keys.
		await store.zadd('presence:site', 'ghost-token', staleSec);
		await store.zadd('presence:c:doc', '3:ghost-token', staleSec);
		expect(await readSitePresence(deps)).toEqual({ site: 0, day: 0, peak: 0 });
		expect(await readContentPresence('doc', deps)).toEqual({
			count: 0,
			histogram: histogramWith({})
		});
		expect(await readContentDots('doc', deps)).toEqual([]);
	});

	it('keeps the peak while a day drains, then resets on the next day', async () => {
		let now = T0;
		const store = new MemoryCacheStore({ clock: () => now });
		const deps = { store, now: () => now, timezone: 'UTC' };
		await touchPresence({ token: 'tok-a' }, deps);
		now += 15_000;
		await touchPresence({ token: 'tok-b' }, deps);
		now += 15_000;
		await touchPresence({ token: 'tok-c' }, deps);
		expect((await readSitePresence(deps))?.peak).toBe(3);
		// Jump a day and beat once: today's numbers restart at 1.
		now += 24 * 60 * 60 * 1000;
		await touchPresence({ token: 'tok-a' }, deps);
		expect(await readSitePresence(deps)).toEqual({ site: 1, day: 1, peak: 1 });
		// Yesterday's sentinel and day set survive (48h TTL, not touched).
		expect(await store.scard('presence:day:2026-10-16')).toBe(3);
		expect((await store.zrangeAbove('presence:max:2026-10-16', -Infinity)).length).toBeGreaterThan(
			0
		);
	});

	it('guards the bucket range on write and skips junk members on read', async () => {
		const store = new MemoryCacheStore();
		const deps = { store, now: () => T0, timezone: 'UTC' };
		await touchPresence({ token: 'tok', contentId: 'doc', bucket: 99 }, deps);
		// Observable at the store, not only at read: the write-side guard must
		// keep a junk bucket out of the key entirely (a reader-side skip alone
		// would pass the read assertion above while still writing '99:tok').
		expect(await store.zcountAbove('presence:c:doc', -Infinity)).toBe(0);
		await touchPresence({ token: 'tok', contentId: 'doc', bucket: -1 }, deps);
		await touchPresence({ token: 'tok', contentId: 'doc', bucket: 20 }, deps);
		expect(await store.zcountAbove('presence:c:doc', -Infinity)).toBe(0);
		expect(await readContentPresence('doc', deps)).toEqual({
			count: 0,
			histogram: histogramWith({})
		});
		const sec = Math.floor(T0 / 1000);
		await store.zadd('presence:c:doc2', 'x:tok', sec);
		await store.zadd('presence:c:doc2', '20:tok', sec);
		await store.zadd('presence:c:doc2', '5:tok', sec);
		expect(await readContentPresence('doc2', deps)).toEqual({
			count: 1,
			histogram: histogramWith({ 5: 1 })
		});
		// A bare bucket prefix ('3:') must not count as a reader (the token
		// slice would otherwise be an empty string).
		await store.zadd('presence:c:doc3', '3:', sec);
		expect(await readContentPresence('doc3', deps)).toEqual({
			count: 0,
			histogram: histogramWith({})
		});
	});

	it('collapses a moving token to its newest bucket (M7)', async () => {
		let now = T0;
		const store = new MemoryCacheStore({ clock: () => now });
		const deps = { store, now: () => now, timezone: 'UTC' };
		await touchPresence({ token: 'tok-a', contentId: 'doc', bucket: 3 }, deps);
		now += 5_000;
		await touchPresence({ token: 'tok-a', contentId: 'doc', bucket: 12 }, deps);
		// Two members for one tab: the reader counts once, at the NEWEST
		// bucket (a member-count read would answer 2 with a split histogram).
		expect(await readContentPresence('doc', deps)).toEqual({
			count: 1,
			histogram: histogramWith({ 12: 1 })
		});
		expect(await readContentDots('doc', deps)).toEqual([12]);
	});

	it('caps the dots payload at the latest five readers', async () => {
		const store = new MemoryCacheStore();
		const deps = { store, now: () => T0, timezone: 'UTC' };
		const sec = Math.floor(T0 / 1000);
		for (let index = 0; index < 7; index += 1) {
			await store.zadd('presence:c:doc', `${index}:tok-${index}`, sec - 30 + index * 3);
		}
		// Seven active readers: the count sees all seven, the dots payload
		// keeps only the five most recently active (buckets 2..6, oldest-first).
		expect(await readContentPresence('doc', deps)).toEqual({
			count: 7,
			histogram: histogramWith({ 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 })
		});
		const dots = await readContentDots('doc', deps);
		expect(dots).toEqual([2, 3, 4, 5, 6]);
		expect(dots).toHaveLength(PRESENCE_DOTS_LIMIT); // the export is consumed here
	});

	it('keeps the dots in latest-activity order when a token moves (delete+reinsert)', async () => {
		const store = new MemoryCacheStore();
		const deps = { store, now: () => T0, timezone: 'UTC' };
		const sec = Math.floor(T0 / 1000);
		// Two movers (double buckets) interleaved with singles inside the
		// window. Members arrive score-ascending (f,a,b,c,d,e,a,b), so the
		// latest-activity order is f,c,d,e,a,b and the cap keeps buckets
		// [4,5,6,7,8] ascending. A Map WITHOUT the delete+reinsert would
		// keep first-occurrence insertion order (f,a,b,c,d,e) and answer
		// [7,8,4,5,6] here (review-corrected arithmetic).
		await store.zadd('presence:c:doc', '1:tok-a', sec - 50);
		await store.zadd('presence:c:doc', '7:tok-a', sec - 30);
		await store.zadd('presence:c:doc', '2:tok-b', sec - 48);
		await store.zadd('presence:c:doc', '8:tok-b', sec - 25);
		await store.zadd('presence:c:doc', '4:tok-c', sec - 45);
		await store.zadd('presence:c:doc', '5:tok-d', sec - 40);
		await store.zadd('presence:c:doc', '6:tok-e', sec - 35);
		await store.zadd('presence:c:doc', '3:tok-f', sec - 55);
		expect(await readContentDots('doc', deps)).toEqual([4, 5, 6, 7, 8]);
		expect(await readContentPresence('doc', deps)).toEqual({
			count: 6,
			histogram: histogramWith({ 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 })
		});
	});

	it('keeps latest-activity order distinct from plain bucket order (a falling mover)', async () => {
		const store = new MemoryCacheStore();
		const deps = { store, now: () => T0, timezone: 'UTC' };
		const sec = Math.floor(T0 / 1000);
		// x moves 9 -> 3 (back up the page); activity order p,q,r,s,t,x keeps
		// its reinserted tail, so the capped payload is [2,4,5,6,3]. A
		// sort-by-bucket implementation would answer [2,3,4,5,6] instead.
		await store.zadd('presence:c:doc', '1:p', sec - 50);
		await store.zadd('presence:c:doc', '2:q', sec - 48);
		await store.zadd('presence:c:doc', '9:x', sec - 45);
		await store.zadd('presence:c:doc', '4:r', sec - 40);
		await store.zadd('presence:c:doc', '5:s', sec - 35);
		await store.zadd('presence:c:doc', '6:t', sec - 30);
		await store.zadd('presence:c:doc', '3:x', sec - 25);
		expect(await readContentDots('doc', deps)).toEqual([2, 4, 5, 6, 3]);
		expect(await readContentPresence('doc', deps)).toEqual({
			count: 6,
			histogram: histogramWith({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 })
		});
	});

	it('refreshes the TTL on every write instead of NX (R-1)', async () => {
		let now = T0;
		const store = new MemoryCacheStore({ clock: () => now });
		const deps = { store, now: () => now, timezone: 'UTC' };
		await touchPresence({ token: 'tok-a' }, deps);
		// Age the key's TTL artificially, then beat again: a refreshing EXPIRE
		// restores ~48h; an NX-style expire would leave the 100s TTL in place.
		await store.expire('presence:site', 100);
		now += 50_000;
		await touchPresence({ token: 'tok-a' }, deps);
		now += 60_000; // 110s after the short TTL was set: NX would be gone
		expect(await store.zcountAbove('presence:site', -Infinity)).toBe(1);
		// The refreshed TTL really is ~48h: a +49h jump expires the key.
		now += 49 * 60 * 60 * 1000;
		expect(await store.zcountAbove('presence:site', -Infinity)).toBe(0);
	});

	it('reads at the window edge with an exclusive cutoff', async () => {
		const store = new MemoryCacheStore();
		const deps = { store, now: () => T0, timezone: 'UTC' };
		const sec = Math.floor(T0 / 1000);
		await store.zadd('presence:site', 'edge-old', sec - 61);
		await store.zadd('presence:site', 'edge-exact', sec - 60);
		await store.zadd('presence:site', 'edge-fresh', sec - 59);
		// 61s out and the EXACT cutoff are excluded; a 59s-old beat stays.
		expect((await readSitePresence(deps))?.site).toBe(1);
	});

	it('peaks by the sentinel VALUE, not the member count (3 -> 2 -> 5)', async () => {
		let now = T0;
		const store = new MemoryCacheStore({ clock: () => now });
		const deps = { store, now: () => now, timezone: 'UTC' };
		await touchPresence({ token: 'tok-a' }, deps);
		await touchPresence({ token: 'tok-b' }, deps);
		await touchPresence({ token: 'tok-c' }, deps);
		now += 61_000; // a, b, c age out
		await touchPresence({ token: 'tok-d' }, deps);
		await touchPresence({ token: 'tok-e' }, deps);
		now += 61_000; // d, e age out
		for (const token of ['tok-f', 'tok-g', 'tok-h', 'tok-i', 'tok-j']) {
			await touchPresence({ token }, deps);
		}
		expect((await readSitePresence(deps))?.peak).toBe(5);
		expect((await readSitePresence(deps))?.site).toBe(5);
		// The sampled sequence alone cannot discriminate max-from-length
		// (upserted members {1..5}: a length read would also answer 5); a
		// synthetic sentinel member ABOVE every count pins the max read
		// (a length read would answer 6 here).
		await store.zadd('presence:max:2026-10-16', '9', 9);
		expect((await readSitePresence(deps))?.peak).toBe(9);
	});

	it('honours site.timezone for the day buckets (mocked Asia/Tokyo)', async () => {
		const store = new MemoryCacheStore();
		// 16:00Z is already the NEXT day in Tokyo; no deps.timezone override,
		// so this exercises the memoised site.timezone resolver.
		await touchPresence({ token: 'tok' }, { store, now: () => Date.UTC(2026, 9, 16, 16) });
		expect(await store.scard('presence:day:2026-10-17')).toBe(1);
		expect(await store.scard('presence:day:2026-10-16')).toBe(0);
	});

	it('degrades reads to null and keeps heartbeats quiet when the cache is dead', async () => {
		const deps = { store: throwingStore(), now: () => T0, timezone: 'UTC' };
		await expect(
			touchPresence({ token: 'tok', contentId: 'doc', bucket: 3 }, deps)
		).resolves.toBeUndefined();
		expect(await readSitePresence(deps)).toBeNull();
		expect(await readContentPresence('doc', deps)).toBeNull();
		expect(await readContentDots('doc', deps)).toBeNull();
	});
});

describe('getCache construction failures (fail-open at the service boundary)', () => {
	it('degrades every read to null and keeps touch quiet', async () => {
		// No deps.store anywhere here: each call falls to the throwing
		// getCache mock, and the service must swallow it — this is the
		// dashboard's only defense against a malformed VALKEY_URL (it calls
		// readSitePresence directly from its load).
		await expect(touchPresence({ token: 'tok' })).resolves.toBeUndefined();
		expect(await readSitePresence()).toBeNull();
		expect(await readContentPresence('doc')).toBeNull();
		expect(await readContentDots('doc')).toBeNull();
	});
});
