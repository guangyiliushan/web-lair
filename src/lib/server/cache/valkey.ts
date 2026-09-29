import Valkey from 'iovalkey';
import { CACHE_PREFIX, type CacheStore } from './store';

/**
 * Valkey-backed store (iovalkey — the valkey.io-listed client that ships pure
 * JS and therefore runs everywhere, including Windows dev; ledger §21).
 * Degradation contract: get/set/del swallow infrastructure errors (miss /
 * no-op); `incr` rethrows so `rateLimit()` owns the fail-open decision. One
 * warning per process keeps an outage visible without flooding logs.
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
				.catch((error: unknown) => {
					this.#connecting = null;
					throw error;
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

	async get<T>(key: string): Promise<T | null> {
		try {
			await this.#ready();
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
			await this.#client.set(CACHE_PREFIX + key, JSON.stringify(value), 'EX', ttlSeconds);
		} catch (error) {
			this.#warn(error);
		}
	}

	async del(key: string): Promise<void> {
		try {
			await this.#ready();
			await this.#client.del(CACHE_PREFIX + key);
		} catch (error) {
			this.#warn(error);
		}
	}

	async incr(key: string, windowSeconds: number): Promise<number> {
		await this.#ready();
		const full = CACHE_PREFIX + key;
		const count = await this.#client.incr(full);
		if (count === 1) await this.#client.expire(full, windowSeconds);
		return count;
	}

	/** Lifecycle hook for scripts/tests: close the connection. */
	async quit(): Promise<void> {
		await this.#client.quit().catch(() => {});
	}
}
