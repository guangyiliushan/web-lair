import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from './memory';
import { ValkeyCacheStore } from './valkey';
import { cached, rateLimit, type CacheStore } from './store';

function throwingStore(): CacheStore {
	return {
		get: vi.fn(async () => {
			throw new Error('cache down');
		}),
		set: vi.fn(async () => {
			throw new Error('cache down');
		}),
		del: vi.fn(async () => {
			throw new Error('cache down');
		}),
		incr: vi.fn(async (): Promise<number> => {
			throw new Error('cache down');
		})
	};
}

describe('MemoryCacheStore', () => {
	it('expires entries on the injected clock', async () => {
		let now = 1_000;
		const store = new MemoryCacheStore({ clock: () => now });
		await store.set('k', { v: 1 }, 10);
		expect(await store.get('k')).toEqual({ v: 1 });
		now += 10_001;
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
		const store = new MemoryCacheStore();
		const loader = vi.fn(async () => null);
		await cached(store, 'a', 60, loader);
		await cached(store, 'a', 60, loader);
		expect(loader).toHaveBeenCalledTimes(2);
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
	it('degrades to misses/no-ops and rethrows only from incr', async () => {
		const store = new ValkeyCacheStore('redis://127.0.0.1:6399');
		expect(await store.get('k')).toBeNull();
		await expect(store.set('k', 1, 60)).resolves.toBeUndefined();
		await expect(store.del('k')).resolves.toBeUndefined();
		await expect(store.incr('k', 60)).rejects.toThrow();
		await store.quit();
	});
});
