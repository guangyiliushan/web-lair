/**
 * Cache layer contract (storage line §7, ledger §21; presence surface added
 * with the realtime batch, ledger §23): a small port that fronts Valkey.
 * Consumers go through {@link cached} / {@link rateLimit} and the sorted-set
 * primitives behind `services/presence.ts`; PG stays the single source of
 * truth and the cache must be loseable at any moment (restart, outage)
 * without affecting correctness.
 *
 * Failure split (T14): the KV writes and the presence writes below are
 * best-effort (implementations swallow infrastructure failures), while
 * `incr` and the presence READS MAY throw — their callers (`rateLimit`, the
 * presence service) own the fail-open decision, because for them "zero" and
 * "unavailable" are different answers.
 */

export interface ScoredMember {
	member: string;
	score: number;
}

export interface CacheStore {
	get<T>(key: string): Promise<T | null>;
	set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
	/**
	 * Increment a windowed counter; the first increment starts the window.
	 * Implementations MAY throw on infrastructure failure — `rateLimit`
	 * decides what a dead cache means for the caller (it allows the action).
	 */
	incr(key: string, windowSeconds: number): Promise<number>;
	/**
	 * Sorted-set surface for presence (ledger §23): members scored by epoch
	 * seconds and windowed by score comparison. `zadd` / `ztrim` / `sadd` /
	 * `expire` are best-effort (swallow failures like `set`); `zcountAbove` /
	 * `zrangeAbove` / `scard` MAY throw like `incr` — the presence service
	 * decides what an unavailable cache renders ("—" / hidden badge).
	 */
	zadd(key: string, member: string, score: number): Promise<void>;
	/** Drop members scored at or below `maxScore` (ZREMRANGEBYSCORE -inf max). */
	ztrim(key: string, maxScore: number): Promise<void>;
	/** Count members scored strictly above `minScore` (ZCOUNT (min +inf). */
	zcountAbove(key: string, minScore: number): Promise<number>;
	/** Members scored strictly above `minScore`, ascending by (score, member). */
	zrangeAbove(key: string, minScore: number): Promise<ScoredMember[]>;
	/** Add one member to a plain set (SADD). */
	sadd(key: string, member: string): Promise<void>;
	/** Cardinality of a plain set (SCARD). */
	scard(key: string): Promise<number>;
	/**
	 * (Re)set the key TTL (EXPIRE). Refresh semantics, deliberately NOT NX:
	 * a presence key must never die while it is still being written
	 * (2026-10-16 review, R-1).
	 */
	expire(key: string, ttlSeconds: number): Promise<void>;
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
