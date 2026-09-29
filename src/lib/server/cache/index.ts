import { env } from '$env/dynamic/private';
import { MemoryCacheStore } from './memory';
import { ValkeyCacheStore } from './valkey';
import type { CacheStore } from './store';

const GLOBAL_KEY = Symbol.for('web-lair.cache');

/**
 * Process-wide cache store, pinned on globalThis so dev HMR reuses one
 * instance (and one Valkey connection). VALKEY_URL selects the backend;
 * without it (tests, bare dev) the in-memory store carries the same contract.
 */
export function getCache(): CacheStore {
	const holder = globalThis as unknown as Record<symbol, CacheStore | undefined>;
	let store = holder[GLOBAL_KEY];
	if (!store) {
		const url = env.VALKEY_URL?.trim();
		store = url ? new ValkeyCacheStore(url) : new MemoryCacheStore();
		holder[GLOBAL_KEY] = store;
	}
	return store;
}
