/**
 * Readiness probe: `/api/health` stays dependency-free
 * (liveness - a DB blip must not restart the container); `/api/ready` is the
 * readiness half - DB `select 1` and a Valkey PING, each bounded to 2s and the
 * combined answer cached for 10s.
 *
 * Why these numbers: Gatus polls on a minute scale, so 10s keeps a recovery
 * visible within one interval while collapsing a burst into one round trip;
 * 2s is shorter than any useful probe timeout, so a wedged connection is
 * reported as `timeout` (distinct from `fail`) instead of hanging the request.
 *
 * The module is dependency-injected on purpose: the route wires the real
 * drizzle/Valkey handles, the unit tests wire plain functions, and neither the
 * timeout nor the cache behaviour needs a live database.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Per-check bound (DB and Valkey are probed in parallel). */
export const READY_TIMEOUT_MS = 2_000;
/** Combined answer cache: one round trip per 10s per process. */
export const READY_CACHE_MS = 10_000;

export type ReadyCheckState = 'ok' | 'fail' | 'timeout' | 'disabled';

export interface ReadyResult {
	status: 'ready' | 'not_ready';
	db: ReadyCheckState;
	valkey: ReadyCheckState;
	/** ISO timestamp of the underlying check (not of the cached read). */
	checkedAt: string;
	cached: boolean;
}

export interface ReadyDeps {
	/** Resolves when the database answers; rejects otherwise. */
	db: () => Promise<unknown>;
	/** null when Valkey is not configured (dev / memory store). */
	valkey: (() => Promise<void>) | null;
	now?: () => Date;
	timeoutMs?: number;
}

class ReadyTimeoutError extends Error {}

/** Race a promise against a timer; the original settles unobserved. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new ReadyTimeoutError('ready check timed out')),
			timeoutMs
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

async function probeCheck(
	check: () => Promise<unknown>,
	timeoutMs: number
): Promise<ReadyCheckState> {
	try {
		// `then(check)` turns a synchronous throw into a rejection.
		await withTimeout(Promise.resolve().then(check), timeoutMs);
		return 'ok';
	} catch (error) {
		return error instanceof ReadyTimeoutError ? 'timeout' : 'fail';
	}
}

/** Run both checks in parallel and reduce them to one readiness verdict. */
export async function evaluateReady(deps: ReadyDeps): Promise<ReadyResult> {
	const timeoutMs = deps.timeoutMs ?? READY_TIMEOUT_MS;
	const [db, valkey] = await Promise.all([
		probeCheck(deps.db, timeoutMs),
		deps.valkey ? probeCheck(deps.valkey, timeoutMs) : Promise.resolve<ReadyCheckState>('disabled')
	]);
	const ready = db === 'ok' && (valkey === 'ok' || valkey === 'disabled');
	return {
		status: ready ? 'ready' : 'not_ready',
		db,
		valkey,
		checkedAt: (deps.now?.() ?? new Date()).toISOString(),
		cached: false
	};
}

/**
 * Small TTL cache with in-flight collapsing. `cached: true` marks a value
 * served inside the window so an operator can tell "just checked" from
 * "reported from the last round trip".
 */
export class ReadyCache {
	#ttlMs: number;
	#now: () => number;
	#at = Number.NEGATIVE_INFINITY;
	#value: ReadyResult | null = null;
	#pending: Promise<ReadyResult> | null = null;

	constructor(ttlMs = READY_CACHE_MS, now: () => number = Date.now) {
		this.#ttlMs = ttlMs;
		this.#now = now;
	}

	async read(compute: () => Promise<ReadyResult>): Promise<ReadyResult> {
		if (this.#value && this.#now() - this.#at < this.#ttlMs) {
			return { ...this.#value, cached: true };
		}
		if (this.#pending) return this.#pending;
		this.#pending = compute()
			.then((value) => {
				this.#value = value;
				this.#at = this.#now();
				return value;
			})
			.finally(() => {
				this.#pending = null;
			});
		return this.#pending;
	}

	reset(): void {
		this.#at = Number.NEGATIVE_INFINITY;
		this.#value = null;
		this.#pending = null;
	}
}

let probe: ReadyCache | null = null;

/** Process-wide readiness cache (the route uses this). */
export function readyProbe(): ReadyCache {
	probe ??= new ReadyCache();
	return probe;
}

/** Test hook: drop the cached readiness answer. */
export function resetReadyProbe(): void {
	probe = null;
}

/**
 * Constant-time `Authorization: Bearer <token>` check. Both sides are hashed
 * to a fixed 32 bytes first: `timingSafeEqual` needs equal-length buffers, and
 * comparing raw values would leak the token length through the early return.
 */
export function bearerMatches(header: string | null, token: string): boolean {
	if (!header) return false;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	if (!match) return false;
	const supplied = createHash('sha256')
		.update(match[1] ?? '', 'utf8')
		.digest();
	const expected = createHash('sha256').update(token, 'utf8').digest();
	return timingSafeEqual(supplied, expected);
}
