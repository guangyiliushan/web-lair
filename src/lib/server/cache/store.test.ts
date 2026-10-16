import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from './memory';
import { ValkeyCacheStore } from './valkey';
import { cached, rateLimit, type CacheStore } from './store';

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

describe('MemoryCacheStore', () => {
	it('expires entries on the injected clock', async () => {
		let now = 1_000;
		const store = new MemoryCacheStore({ clock: () => now });
		await store.set('k', { v: 1 }, 10);
		expect(await store.get('k')).toEqual({ v: 1 });
		now += 10_000; // boundary: entries expire AT the TTL, not after it
		expect(await store.get('k')).toBeNull();
	});

	it('keeps the rate-limit window TTL across increments', async () => {
		let now = 0;
		const store = new MemoryCacheStore({ clock: () => now });
		expect(await store.incr('limits:x', 60)).toBe(1);
		expect(await store.incr('limits:x', 60)).toBe(2);
		now += 60_001;
		expect(await store.incr('limits:x', 60)).toBe(1); // new window
	});

	it('keeps a fixed window while increments continue (no sliding)', async () => {
		let now = 1_000_000;
		const store = new MemoryCacheStore({ clock: () => now });
		expect(await store.incr('limits:y', 60)).toBe(1);
		now += 30_000;
		expect(await store.incr('limits:y', 60)).toBe(2);
		now += 31_000; // 61s total: past the ORIGINAL window despite activity
		expect(await store.incr('limits:y', 60)).toBe(1);
	});

	it('increments atomically under concurrency (security review finding)', async () => {
		// Regression: incr() used to await get() between the read and the
		// write, so 20 concurrent submissions all read count=0 and passed.
		const store = new MemoryCacheStore();
		const results = await Promise.all(
			Array.from({ length: 20 }, () => rateLimit(store, 'limits:z', 2, 60))
		);
		expect(results.filter((result) => result.allowed)).toHaveLength(2);
		expect(Math.max(...results.map((result) => result.count))).toBe(20);
	});
});

describe('MemoryCacheStore presence primitives', () => {
	it('windows sorted sets with an exclusive lower bound', async () => {
		const store = new MemoryCacheStore();
		await store.zadd('presence:site', 'stale', 100);
		await store.zadd('presence:site', 'fresh', 200);
		expect(await store.zcountAbove('presence:site', 150)).toBe(1);
		expect(await store.zrangeAbove('presence:site', 150)).toEqual([
			{ member: 'fresh', score: 200 }
		]);
		// The bound itself is dead on the read side too (window edges agree).
		expect(await store.zcountAbove('presence:site', 200)).toBe(0);
	});

	it('trims at or below the cutoff and drops the emptied key', async () => {
		const store = new MemoryCacheStore();
		await store.zadd('z', 'old', 100);
		await store.zadd('z', 'new', 200);
		await store.ztrim('z', 150);
		expect(await store.zrangeAbove('z', -Infinity)).toEqual([{ member: 'new', score: 200 }]);
		await store.ztrim('z', 999);
		expect(await store.zcountAbove('z', -Infinity)).toBe(0);
	});

	it('orders ranges by score, then member (Valkey tie-break)', async () => {
		const store = new MemoryCacheStore();
		await store.zadd('z', 'b', 5);
		await store.zadd('z', 'a', 5);
		await store.zadd('z', 'c', 1);
		expect((await store.zrangeAbove('z', -Infinity)).map((entry) => entry.member)).toEqual([
			'c',
			'a',
			'b'
		]);
	});

	it('dedupes set members and counts them', async () => {
		const store = new MemoryCacheStore();
		await store.sadd('s', 'tok-a');
		await store.sadd('s', 'tok-a');
		await store.sadd('s', 'tok-b');
		expect(await store.scard('s')).toBe(2);
		expect(await store.scard('missing')).toBe(0);
	});

	it('refreshes the TTL on expire() and keeps keys without one', async () => {
		let now = 0;
		const store = new MemoryCacheStore({ clock: () => now });
		await store.zadd('z', 'm', 1);
		now += 1_000_000_000; // no TTL yet: the key must survive
		expect(await store.zcountAbove('z', -Infinity)).toBe(1);
		await store.expire('z', 10);
		now += 9_000;
		await store.expire('z', 10); // refresh, not NX: this extends the life
		now += 9_000; // 18s since creation, 9s since the refresh
		expect(await store.zcountAbove('z', -Infinity)).toBe(1);
		now += 1_001;
		expect(await store.zcountAbove('z', -Infinity)).toBe(0);
	});

	it('does not extend the TTL on plain writes (ZADD keeps expiry)', async () => {
		let now = 0;
		const store = new MemoryCacheStore({ clock: () => now });
		await store.zadd('z', 'm', 1);
		await store.expire('z', 10);
		now += 5_000;
		await store.zadd('z', 'm', 2); // must NOT clear or refresh the TTL
		await store.zadd('z', 'other', 2);
		now += 5_001; // 10s after expire()
		expect(await store.zcountAbove('z', -Infinity)).toBe(0);
	});

	it('expire() on a missing key is a no-op', async () => {
		const store = new MemoryCacheStore();
		await store.expire('missing', 10);
		expect(await store.get('missing')).toBeNull();
	});
});

describe('cached()', () => {
	it('serves a hit without calling the loader and stores misses', async () => {
		const store = new MemoryCacheStore();
		const loader = vi.fn(async () => ({ value: 42 }));
		expect(await cached(store, 'a', 60, loader)).toEqual({ value: 42 });
		expect(await cached(store, 'a', 60, loader)).toEqual({ value: 42 });
		expect(loader).toHaveBeenCalledOnce();
	});

	it('is fail-open when the store throws on read or write', async () => {
		const loader = vi.fn(async () => 'value');
		expect(await cached(throwingStore(), 'a', 60, loader)).toBe('value');
		const failingWrite: CacheStore = { ...throwingStore(), get: vi.fn(async () => null) };
		expect(await cached(failingWrite, 'a', 60, loader)).toBe('value');
		expect(loader).toHaveBeenCalledTimes(2);
	});

	it('does not cache null results (failures stay failures)', async () => {
		// A recording set() gives this teeth: MemoryCacheStore alone cannot
		// distinguish "stored null" from "miss" (round-2 mutation m10).
		const inner = new MemoryCacheStore();
		const setSpy = vi.fn((key: string, value: unknown, ttl: number) => inner.set(key, value, ttl));
		const store: CacheStore = {
			get: (key) => inner.get(key),
			set: setSpy,
			incr: (key, ttl) => inner.incr(key, ttl),
			zadd: (key, member, score) => inner.zadd(key, member, score),
			ztrim: (key, maxScore) => inner.ztrim(key, maxScore),
			zcountAbove: (key, minScore) => inner.zcountAbove(key, minScore),
			zrangeAbove: (key, minScore) => inner.zrangeAbove(key, minScore),
			sadd: (key, member) => inner.sadd(key, member),
			scard: (key) => inner.scard(key),
			expire: (key, ttl) => inner.expire(key, ttl)
		};
		const loader = vi.fn(async () => null);
		await cached(store, 'a', 60, loader);
		await cached(store, 'a', 60, loader);
		expect(loader).toHaveBeenCalledTimes(2);
		expect(setSpy).not.toHaveBeenCalled();
	});
});

describe('rateLimit()', () => {
	it('blocks only past the limit within one window', async () => {
		const store = new MemoryCacheStore();
		expect((await rateLimit(store, 'limits:up', 2, 60)).allowed).toBe(true);
		expect((await rateLimit(store, 'limits:up', 2, 60)).allowed).toBe(true);
		expect((await rateLimit(store, 'limits:up', 2, 60)).allowed).toBe(false);
	});

	it('fails open when the counter store is down', async () => {
		expect((await rateLimit(throwingStore(), 'limits:up', 1, 60)).allowed).toBe(true);
	});
});

describe('ValkeyCacheStore (fail-open against a dead endpoint)', () => {
	it('degrades: KV/presence writes no-op, incr and presence reads rethrow', async () => {
		const store = new ValkeyCacheStore('redis://127.0.0.1:6399');
		expect(await store.get('k')).toBeNull();
		await expect(store.set('k', 1, 60)).resolves.toBeUndefined();
		await expect(store.incr('k', 60)).rejects.toThrow();
		// Presence split (store contract): best-effort writes resolve...
		await expect(store.zadd('k', 'm', 1)).resolves.toBeUndefined();
		await expect(store.ztrim('k', 1)).resolves.toBeUndefined();
		await expect(store.sadd('k', 'm')).resolves.toBeUndefined();
		await expect(store.expire('k', 60)).resolves.toBeUndefined();
		// ...while the reads rethrow so the presence service can degrade.
		await expect(store.zcountAbove('k', 0)).rejects.toThrow();
		await expect(store.zrangeAbove('k', 0)).rejects.toThrow();
		await expect(store.scard('k')).rejects.toThrow();
		await store.quit();
	}, 30_000);
});
