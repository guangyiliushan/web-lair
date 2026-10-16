import Valkey from 'iovalkey';
import { CACHE_PREFIX, type CacheStore, type ScoredMember } from './store';

/**
 * Valkey-backed store (iovalkey — the valkey.io-listed client that ships pure
 * JS and therefore runs everywhere, including Windows dev; ledger §21).
 * Degradation contract: KV access and the presence writes (zadd/ztrim/sadd/
 * expire) swallow infrastructure errors; `incr` and the presence reads
 * (zcountAbove/zrangeAbove/scard) rethrow so their callers (`rateLimit()` /
 * `services/presence.ts`) own the fail-open decision. One warning per outage
 * keeps an outage visible without flooding logs; a recovery line re-arms the
 * warning for the next outage.
 */
export class ValkeyCacheStore implements CacheStore {
	readonly #client: Valkey;
	#connecting: Promise<void> | null = null;
	#warned = false;

	constructor(url: string) {
		this.#client = new Valkey(url, {
			lazyConnect: true,
			enableOfflineQueue: false,
			maxRetriesPerRequest: 1,
			retryStrategy: (attempt) => (attempt > 3 ? null : Math.min(attempt * 200, 1000))
		});
		this.#client.on('error', (error: unknown) => this.#warn(error));
	}

	async #ready(): Promise<void> {
		if (this.#client.status === 'ready') return;
		if (!this.#connecting) {
			this.#connecting = this.#client
				.connect()
				.then(() => undefined)
				.finally(() => {
					// Clear on success too: after a later outage that exhausts the
					// retry strategy the client reaches 'end', and the next call
					// must start a fresh connect() to recover — awaiting a stale
					// resolved promise would keep the cache degraded forever.
					this.#connecting = null;
				});
		}
		await this.#connecting;
	}

	#warn(error: unknown): void {
		if (this.#warned) return;
		this.#warned = true;
		console.warn(
			'[cache] Valkey unavailable; continuing fail-open',
			error instanceof Error ? error.message : error
		);
	}

	/**
	 * Log one recovery line after an outage and re-arm warnings, so a later
	 * (possibly different) failure is not hidden by the first one.
	 */
	#noteSuccess(): void {
		if (!this.#warned) return;
		this.#warned = false;
		console.warn('[cache] Valkey connection recovered');
	}

	async get<T>(key: string): Promise<T | null> {
		try {
			await this.#ready();
			this.#noteSuccess();
			const raw = await this.#client.get(CACHE_PREFIX + key);
			return raw === null ? null : (JSON.parse(raw) as T);
		} catch (error) {
			this.#warn(error);
			return null;
		}
	}

	async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
		try {
			await this.#ready();
			this.#noteSuccess();
			await this.#client.set(CACHE_PREFIX + key, JSON.stringify(value), 'EX', ttlSeconds);
		} catch (error) {
			this.#warn(error);
		}
	}

	async incr(key: string, windowSeconds: number): Promise<number> {
		await this.#ready();
		this.#noteSuccess();
		const full = CACHE_PREFIX + key;
		const count = await this.#client.incr(full);
		// NX: only set the window TTL when the key has none. Besides keeping a
		// fixed window across increments, this REPAIRS a counter whose EXPIRE
		// was lost to a crash — a TTL-less counter would never reset
		// (fail-closed), contradicting the fail-open contract.
		await this.#client.expire(full, windowSeconds, 'NX');
		return count;
	}

	async zadd(key: string, member: string, score: number): Promise<void> {
		try {
			await this.#ready();
			this.#noteSuccess();
			await this.#client.zadd(CACHE_PREFIX + key, score, member);
		} catch (error) {
			this.#warn(error);
		}
	}

	async ztrim(key: string, maxScore: number): Promise<void> {
		try {
			await this.#ready();
			this.#noteSuccess();
			await this.#client.zremrangebyscore(CACHE_PREFIX + key, '-inf', maxScore);
		} catch (error) {
			this.#warn(error);
		}
	}

	async zcountAbove(key: string, minScore: number): Promise<number> {
		await this.#ready();
		this.#noteSuccess();
		return this.#client.zcount(CACHE_PREFIX + key, exclusiveLowerBound(minScore), '+inf');
	}

	async zrangeAbove(key: string, minScore: number): Promise<ScoredMember[]> {
		await this.#ready();
		this.#noteSuccess();
		const flat = await this.#client.zrangebyscore(
			CACHE_PREFIX + key,
			exclusiveLowerBound(minScore),
			'+inf',
			'WITHSCORES'
		);
		const members: ScoredMember[] = [];
		for (let index = 0; index + 1 < flat.length; index += 2) {
			members.push({ member: flat[index], score: Number(flat[index + 1]) });
		}
		return members;
	}

	async sadd(key: string, member: string): Promise<void> {
		try {
			await this.#ready();
			this.#noteSuccess();
			await this.#client.sadd(CACHE_PREFIX + key, member);
		} catch (error) {
			this.#warn(error);
		}
	}

	async scard(key: string): Promise<number> {
		await this.#ready();
		this.#noteSuccess();
		return this.#client.scard(CACHE_PREFIX + key);
	}

	async expire(key: string, ttlSeconds: number): Promise<void> {
		try {
			await this.#ready();
			this.#noteSuccess();
			await this.#client.expire(CACHE_PREFIX + key, ttlSeconds);
		} catch (error) {
			this.#warn(error);
		}
	}

	/** Lifecycle hook for scripts/tests: close the connection. */
	async quit(): Promise<void> {
		await this.#client.quit().catch(() => {});
	}
}

/**
 * Exclusive lower bound for the window reads: `(min` keeps the read boundary
 * consistent with the write-side trim (members at or below the cutoff are
 * dead). ±Infinity map to the infinities ZCOUNT/ZRANGEBYSCORE accept.
 * Exported for the syntax pins in store.test.ts (review finding).
 */
export function exclusiveLowerBound(minScore: number): string {
	if (minScore === -Infinity) return '-inf';
	if (minScore === Infinity) return '+inf';
	return `(${minScore}`;
}
