import type { CacheStore } from './store';

/** Cap so a long-lived process cannot grow without bound (evict oldest). */
const MAX_ENTRIES = 1000;

interface Entry {
	value: unknown;
	expiresAt: number;
}

/**
 * In-memory store: used when VALKEY_URL is absent (tests, scripts, bare dev)
 * and as the semantic reference for the Valkey implementation.
 */
export class MemoryCacheStore implements CacheStore {
	readonly #entries = new Map<string, Entry>();
	readonly #clock: () => number;

	constructor(options: { clock?: () => number } = {}) {
		this.#clock = options.clock ?? (() => Date.now());
	}

	async get<T>(key: string): Promise<T | null> {
		const entry = this.#entries.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= this.#clock()) {
			this.#entries.delete(key);
			return null;
		}
		return entry.value as T;
	}

	async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
		this.#entries.delete(key); // refresh insertion order on write
		this.#entries.set(key, { value, expiresAt: this.#clock() + ttlSeconds * 1000 });
		if (this.#entries.size > MAX_ENTRIES) {
			const oldest = this.#entries.keys().next().value;
			if (oldest !== undefined) this.#entries.delete(oldest);
		}
	}

	async incr(key: string, windowSeconds: number): Promise<number> {
		const current = await this.get<number>(key);
		if (current === null) {
			this.#entries.set(key, { value: 1, expiresAt: this.#clock() + windowSeconds * 1000 });
			return 1;
		}
		const next = current + 1;
		const entry = this.#entries.get(key);
		if (entry) entry.value = next;
		return next;
	}
}
