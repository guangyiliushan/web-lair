import { describe, expect, it, vi } from 'vitest';
import { runDrain, sanitizeErrorText } from './drain';
import type { JobsDb } from './types';

/**
 * Tick-level guarantees that need no database (plan §2): the drain resolves
 * even when whole segments blow up (segment isolation - the later segments
 * still run), a tick with nothing to do reports zeros, heartbeat failures
 * never fail the tick, and a job timeout aborts the tick (the stuck job dies
 * with the hard-exiting process).
 */

/**
 * Chain mock with a scripted result queue: every awaited link pops the next
 * entry, which pins the exact statement order of one schedule firing (select
 * schedules -> reclaim -> [tx: CAS, insert] -> source hash -> finalize).
 * An exhausted queue resolves [] - `makeScriptedDb([])` is the empty database.
 */
function makeScriptedDb(results: unknown[][]): JobsDb {
	let index = 0;
	const next = () => Promise.resolve(results[index++] ?? []);
	const chain: unknown = new Proxy(function () {}, {
		get(_target, prop) {
			if (prop === 'then') {
				return (resolve: (value: unknown) => unknown) => next().then(resolve);
			}
			return () => chain;
		},
		apply() {
			return chain;
		}
	});
	const tx = { select: () => chain, update: () => chain, insert: () => chain, delete: () => chain };
	return {
		select: () => chain,
		update: () => chain,
		insert: () => chain,
		delete: () => chain,
		transaction: async (fn: (client: unknown) => unknown) => fn(tx)
	} as unknown as JobsDb;
}

const emptyDb = () => makeScriptedDb([]);
const fixedNow = () => new Date('2026-01-01T00:00:00.000Z');
const neverAcquires = async () => null;
const unusedLoader = async () => {
	throw new Error('loadJob must not be called in these scenarios');
};

describe('runDrain', () => {
	it('an empty tick reports zeros and no errors', async () => {
		const summary = await runDrain({
			db: emptyDb(),
			acquireLock: neverAcquires,
			loadJob: unusedLoader,
			now: fixedNow
		});
		expect(summary.schedules.checked).toBe(0);
		expect(summary.schedules.fired).toBe(0);
		expect(summary.queue.claimed).toBe(0);
		expect(summary.deliveries.sent).toBe(0);
		expect(summary.segmentErrors).toEqual([]);
		expect(summary.aborted).toBe(false);
		expect(summary.heartbeat).toBe('skipped');
	});

	it('segment isolation: exploding segments are contained and the tick still resolves', async () => {
		const db = {
			select: () => {
				throw new Error('select boom');
			},
			transaction: async () => {
				throw new Error('transaction boom');
			}
		} as unknown as JobsDb;
		const summary = await runDrain({
			db,
			acquireLock: neverAcquires,
			loadJob: unusedLoader,
			now: fixedNow
		});
		expect(summary.segmentErrors).toHaveLength(3);
		expect(summary.segmentErrors[0]).toContain('schedules');
		expect(summary.segmentErrors[1]).toContain('queue');
		// Delivery-segment failures are segment-level too (exit != 0, quiet
		// heartbeat) and counted separately.
		expect(summary.segmentErrors[2]).toContain('deliveries');
		expect(summary.deliveries.errors).toBe(1);
	});

	it('aborts the tick when a job times out (a stuck job can only die with the process)', async () => {
		vi.useFakeTimers();
		try {
			const scheduleRow = {
				id: '00000000-0000-7000-8000-000000000001',
				job: 'system.resources',
				cronExpr: '30 1 * * *',
				tz: 'UTC',
				isEnabled: true,
				lastDueAt: new Date('2025-12-30T01:30:00.000Z')
			};
			const db = makeScriptedDb([
				[scheduleRow], // schedule segment: enabled schedules
				[], // reclaim (returning)
				[{ id: scheduleRow.id }], // CAS watermark (inside the tx)
				[{ id: 'run-timeout' }], // insert run row (inside the tx)
				[], // source_hash update
				[] // finalize (failed)
			]);
			const stuck = new Promise<void>(() => {});
			let releases = 0;
			const drainPromise = runDrain({
				db,
				acquireLock: async () => async () => {
					releases += 1;
				},
				loadJob: async () => ({ run: () => stuck, sourceHash: 'hash' }),
				now: fixedNow
			});
			await vi.advanceTimersByTimeAsync(30_001);
			const summary = await drainPromise;
			expect(summary.aborted).toBe(true);
			expect(summary.segmentErrors.some((entry) => entry.includes('timed out'))).toBe(true);
			// The queue/delivery segments must NOT have run after the abort.
			expect(summary.queue.claimed).toBe(0);
			expect(summary.deliveries.sent).toBe(0);
			// And the lock is deliberately kept: the hard exit takes it down.
			expect(releases).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('sends one heartbeat ping after the tick', async () => {
		const fetchMock = vi.fn(async () => new Response('ok'));
		const summary = await runDrain({
			db: emptyDb(),
			acquireLock: neverAcquires,
			loadJob: unusedLoader,
			now: fixedNow,
			fetch: fetchMock as unknown as typeof fetch,
			heartbeatUrl: 'https://kuma.example/push/token'
		});
		expect(summary.heartbeat).toBe('sent');
		expect(fetchMock).toHaveBeenCalledWith(
			'https://kuma.example/push/token',
			expect.objectContaining({ signal: expect.anything() })
		);
	});

	it('a failing heartbeat is recorded, never fatal', async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error('kuma down');
		});
		const summary = await runDrain({
			db: emptyDb(),
			acquireLock: neverAcquires,
			loadJob: unusedLoader,
			now: fixedNow,
			fetch: fetchMock as unknown as typeof fetch,
			heartbeatUrl: 'https://kuma.example/push/token'
		});
		expect(summary.heartbeat).toBe('failed');
		expect(summary.segmentErrors).toEqual([]);
	});

	it('skips the heartbeat when the tick was degraded (missing ping = alert)', async () => {
		const db = {
			select: () => {
				throw new Error('select boom');
			},
			transaction: async () => {
				throw new Error('transaction boom');
			}
		} as unknown as JobsDb;
		const fetchMock = vi.fn(async () => new Response('ok'));
		const summary = await runDrain({
			db,
			acquireLock: neverAcquires,
			loadJob: unusedLoader,
			now: fixedNow,
			fetch: fetchMock as unknown as typeof fetch,
			heartbeatUrl: 'https://kuma.example/push/token'
		});
		expect(summary.heartbeat).toBe('skipped');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(summary.segmentErrors.length).toBeGreaterThan(0);
	});
});

describe('sanitizeErrorText', () => {
	it('strips the drizzle params tail (bound values may carry secrets)', () => {
		const drizzleShaped =
			'Failed query: update "webhooks" set "secret" = $1\nparams: super-secret-token,1';
		const sanitized = sanitizeErrorText(drizzleShaped);
		expect(sanitized).not.toContain('super-secret-token');
		expect(sanitized).not.toContain('params:');
		expect(sanitized).toContain('Failed query');
	});

	it('redacts URLs (push/webhook endpoints carry tokens in their path)', () => {
		const sanitized = sanitizeErrorText(
			'Failed to parse URL from https://kuma.example/push/secret-token-123'
		);
		expect(sanitized).not.toContain('secret-token-123');
		expect(sanitized).toContain('https://kuma.example/...');
	});

	it('drops multi-line params tails entirely (values may contain newlines)', () => {
		const multiline =
			'Failed query: insert into "webhook_deliveries" values ($1)\nparams: {"a":"line one\nLEAKED-SECRET-LINE"}';
		const sanitized = sanitizeErrorText(multiline);
		expect(sanitized).not.toContain('LEAKED-SECRET-LINE');
		expect(sanitized).not.toContain('params:');
	});

	it('redacts postgres URLs too (connection strings carry credentials)', () => {
		const sanitized = sanitizeErrorText(
			'Failed to parse URL from postgres://root:hunter2@db:5432/x'
		);
		expect(sanitized).not.toContain('hunter2');
		expect(sanitized).toContain('postgres://db:5432/...');
	});

	it('caps the length', () => {
		expect(sanitizeErrorText('x'.repeat(2000))).toHaveLength(500);
	});

	it('coerces non-string input instead of throwing', () => {
		expect(sanitizeErrorText(null)).toBe('');
		expect(sanitizeErrorText(undefined)).toBe('');
	});
});
