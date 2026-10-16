import type { CacheStore, ScoredMember } from './store';

/** Cap so a long-lived process cannot grow without bound (evict oldest). */
const MAX_ENTRIES = 1000;

type Entry =
	| { kind: 'kv'; value: unknown; expiresAt: number }
	| { kind: 'zset'; members: Map<string, number>; expiresAt: number }
	| { kind: 'set'; members: Set<string>; expiresAt: number };

/** No TTL set yet: the entry lives until rewritten or evicted (a real EXPIRE). */
const NO_EXPIRY = Number.POSITIVE_INFINITY;

/**
 * In-memory store: used when VALKEY_URL is absent (tests, scripts, bare dev)
 * and as the semantic reference for the Valkey implementation. Sorted sets
 * order by (score asc, member lexicographic) and abandon a key when its last
 * member is trimmed — both mirror observed Valkey behaviour (live probe,
 * 2026-10-16). Deliberate divergence (review note): values are stored and
 * returned BY REFERENCE here, while Valkey round-trips JSON — callers must
 * not mutate a cached value in place.
 */
export class MemoryCacheStore implements CacheStore {
	readonly #entries = new Map<string, Entry>();
	readonly #clock: () => number;

	constructor(options: { clock?: () => number } = {}) {
		this.#clock = options.clock ?? (() => Date.now());
	}

	#live(key: string): Entry | null {
		const entry = this.#entries.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= this.#clock()) {
			this.#entries.delete(key);
			return null;
		}
		return entry;
	}

	#insert(key: string, entry: Entry): void {
		this.#entries.delete(key); // refresh insertion order on write
		this.#entries.set(key, entry);
		if (this.#entries.size > MAX_ENTRIES) {
			const oldest = this.#entries.keys().next().value;
			if (oldest !== undefined) this.#entries.delete(oldest);
		}
	}

	async get<T>(key: string): Promise<T | null> {
		const entry = this.#live(key);
		return entry?.kind === 'kv' ? (entry.value as T) : null;
	}

	async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
		this.#insert(key, { kind: 'kv', value, expiresAt: this.#clock() + ttlSeconds * 1000 });
	}

	async incr(key: string, windowSeconds: number): Promise<number> {
		// Fully synchronous read-modify-write: there must be NO await between
		// the read and the write, otherwise concurrent submissions all read
		// the same initial value and the window counter collapses (security
		// review finding: 20 concurrent calls, limit=2 -> 20/20 allowed).
		const now = this.#clock();
		const entry = this.#live(key);
		if (entry?.kind !== 'kv') {
			this.#insert(key, { kind: 'kv', value: 1, expiresAt: now + windowSeconds * 1000 });
			return 1;
		}
		const next = (entry.value as number) + 1;
		entry.value = next;
		return next;
	}

	async zadd(key: string, member: string, score: number): Promise<void> {
		const entry = this.#live(key);
		const zset =
			entry?.kind === 'zset'
				? entry
				: { kind: 'zset' as const, members: new Map<string, number>(), expiresAt: NO_EXPIRY };
		zset.members.set(member, score);
		this.#insert(key, zset);
	}

	async ztrim(key: string, maxScore: number): Promise<void> {
		const entry = this.#live(key);
		if (entry?.kind !== 'zset') return;
		for (const [member, score] of entry.members) {
			if (score <= maxScore) entry.members.delete(member);
		}
		// Valkey drops an aggregate key once its last member is removed.
		if (entry.members.size === 0) this.#entries.delete(key);
	}

	async zcountAbove(key: string, minScore: number): Promise<number> {
		const entry = this.#live(key);
		if (entry?.kind !== 'zset') return 0;
		let count = 0;
		for (const score of entry.members.values()) {
			if (score > minScore) count += 1;
		}
		return count;
	}

	async zrangeAbove(key: string, minScore: number): Promise<ScoredMember[]> {
		const entry = this.#live(key);
		if (entry?.kind !== 'zset') return [];
		return [...entry.members.entries()]
			.filter(([, score]) => score > minScore)
			.sort((left, right) => left[1] - right[1] || (left[0] < right[0] ? -1 : 1))
			.map(([member, score]) => ({ member, score }));
	}

	async sadd(key: string, member: string): Promise<void> {
		const entry = this.#live(key);
		const set =
			entry?.kind === 'set'
				? entry
				: { kind: 'set' as const, members: new Set<string>(), expiresAt: NO_EXPIRY };
		set.members.add(member);
		this.#insert(key, set);
	}

	async scard(key: string): Promise<number> {
		const entry = this.#live(key);
		return entry?.kind === 'set' ? entry.members.size : 0;
	}

	async expire(key: string, ttlSeconds: number): Promise<void> {
		const entry = this.#live(key);
		if (!entry) return; // EXPIRE on a missing key is a no-op in Valkey too
		entry.expiresAt = this.#clock() + ttlSeconds * 1000;
	}
}
