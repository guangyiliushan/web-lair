import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '$lib/server/cache/memory';
import type { CacheStore } from '$lib/server/cache/store';
import {
	dateStamp,
	PRESENCE_BUCKETS,
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
