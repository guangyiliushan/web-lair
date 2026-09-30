/**
 * Cache layer contract (storage line §7, ledger §21): a small key/value port
 * that fronts Valkey. Consumers go through {@link cached} / {@link rateLimit};
 * PG stays the single source of truth and the cache must be loseable at any
 * moment (restart, outage) without affecting correctness — every helper and
 * both store implementations are fail-open by contract (T14).
 */

export interface CacheStore {
	get<T>(key: string): Promise<T | null>;
	set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
	/**
	 * Increment a windowed counter; the first increment starts the window.
	 * Implementations MAY throw on infrastructure failure — `rateLimit`
	 * decides what a dead cache means for the caller (it allows the action).
	 */
	incr(key: string, windowSeconds: number): Promise<number>;
}

/** Key namespace (plan §7): everything the app puts in Valkey sits under it. */
export const CACHE_PREFIX = 'wl:';

/**
 * Cache-aside read: hit = cached value; miss = load and populate. Never
 * throws because of cache trouble — a failing store degrades to the loader.
 * `null`/`undefined` results are not cached, so failures stay failures.
 */
export async function cached<T>(
	store: CacheStore,
	key: string,
	ttlSeconds: number,
	loader: () => Promise<T>
): Promise<T> {
	try {
		const hit = await store.get<T>(key);
		if (hit !== null) return hit;
	} catch {
		// fail-open: read straight through
	}
	const value = await loader();
	if (value !== null && value !== undefined) {
		try {
			await store.set(key, value, ttlSeconds);
		} catch {
			// fail-open: serving the fresh value is what matters
		}
	}
	return value;
}

export interface RateLimitResult {
	allowed: boolean;
	count: number;
}

/**
 * Fixed-window counter (plan §7: `wl:limits:<domain>:<key>`, TTL = window).
 * Fail-open: when the store is down every request is allowed — the limiter is
 * a seatbelt, not a gate (the whole site must stay functional without Valkey).
 */
export async function rateLimit(
	store: CacheStore,
	key: string,
	limit: number,
	windowSeconds: number
): Promise<RateLimitResult> {
	try {
		const count = await store.incr(key, windowSeconds);
		return { allowed: count <= limit, count };
	} catch {
		return { allowed: true, count: 0 };
	}
}
