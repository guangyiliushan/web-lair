import { describe, expect, it, vi } from 'vitest';
import {
	READY_CACHE_MS,
	READY_TIMEOUT_MS,
	ReadyCache,
	bearerMatches,
	evaluateReady,
	readyProbe,
	resetReadyProbe
} from './ready';

const ok = async (): Promise<unknown> => undefined;
const okVoid = async (): Promise<void> => undefined;

describe('evaluateReady', () => {
	it('is ready when the database and Valkey both answer', async () => {
		const valkey = vi.fn(async () => {});
		const result = await evaluateReady({ db: ok, valkey, now: () => new Date(0) });
		expect(result).toEqual({
			status: 'ready',
			db: 'ok',
			valkey: 'ok',
			checkedAt: '1970-01-01T00:00:00.000Z',
			cached: false
		});
		expect(valkey).toHaveBeenCalledTimes(1);
	});

	it('treats an unconfigured Valkey as ready with a disabled check', async () => {
		const result = await evaluateReady({ db: ok, valkey: null });
		expect(result).toMatchObject({ status: 'ready', db: 'ok', valkey: 'disabled' });
	});

	it('is not ready when the database check fails', async () => {
		const result = await evaluateReady({
			db: async () => {
				throw new Error('ECONNREFUSED');
			},
			valkey: okVoid
		});
		expect(result).toMatchObject({ status: 'not_ready', db: 'fail', valkey: 'ok' });
	});

	it('distinguishes a timeout from a failure', async () => {
		const result = await evaluateReady({
			db: () => new Promise<never>(() => {}),
			valkey: null,
			timeoutMs: 10
		});
		expect(result).toMatchObject({ status: 'not_ready', db: 'timeout' });
	});

	it('turns a synchronous throw into fail, not a crash', async () => {
		const result = await evaluateReady({
			db: () => {
				throw new Error('boom');
			},
			valkey: null
		});
		expect(result.db).toBe('fail');
	});

	it('keeps the planned timeout and cache values', () => {
		expect(READY_TIMEOUT_MS).toBe(2_000);
		expect(READY_CACHE_MS).toBe(10_000);
	});
});

describe('ReadyCache', () => {
	it('serves a cached verdict inside the 10s window and recomputes at the boundary', async () => {
		let now = 1_000;
		const cache = new ReadyCache(10_000, () => now);
		const compute = vi.fn(async () => evaluateReady({ db: ok, valkey: null }));
		const first = await cache.read(compute);
		expect(first.cached).toBe(false);

		now = 5_000;
		const second = await cache.read(compute);
		expect(second.cached).toBe(true);
		expect(compute).toHaveBeenCalledTimes(1);

		now = 11_000; // exactly at the TTL: a fresh check
		const third = await cache.read(compute);
		expect(third.cached).toBe(false);
		expect(compute).toHaveBeenCalledTimes(2);
	});

	it('collapses concurrent misses into one round trip', async () => {
		const cache = new ReadyCache();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const compute = vi.fn(async () => {
			await gate;
			return evaluateReady({ db: ok, valkey: null });
		});
		const pending = Promise.all([cache.read(compute), cache.read(compute)]);
		release();
		const [left, right] = await pending;
		expect(left.status).toBe('ready');
		expect(right.status).toBe('ready');
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it('reset() drops the cached verdict (test hook)', async () => {
		const cache = new ReadyCache();
		const compute = vi.fn(async () => evaluateReady({ db: ok, valkey: null }));
		await cache.read(compute);
		cache.reset();
		await cache.read(compute);
		expect(compute).toHaveBeenCalledTimes(2);
	});
});

describe('readyProbe singleton', () => {
	it('is stable across calls and resettable', () => {
		resetReadyProbe();
		const first = readyProbe();
		expect(readyProbe()).toBe(first);
		resetReadyProbe();
		expect(readyProbe()).not.toBe(first);
	});
});

describe('bearerMatches', () => {
	it('accepts the exact bearer token only', () => {
		expect(bearerMatches('Bearer s3cret', 's3cret')).toBe(true);
		expect(bearerMatches('bearer s3cret', 's3cret')).toBe(true);
		expect(bearerMatches('Bearer  s3cret', 's3cret')).toBe(true);
		expect(bearerMatches('Bearer wrong', 's3cret')).toBe(false);
		expect(bearerMatches('Basic s3cret', 's3cret')).toBe(false);
		expect(bearerMatches(null, 's3cret')).toBe(false);
		expect(bearerMatches('Bearer s3cret-extra', 's3cret')).toBe(false);
	});
});
