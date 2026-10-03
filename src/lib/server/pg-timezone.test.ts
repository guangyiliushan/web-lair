import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * The batch-5 tz closure helper: membership must come from
 * `pg_timezone_names` (bound parameter, verified at the RENDER level with
 * the real dialect), and the injected executor path must be used as-is so
 * the check can join an open transaction.
 */
const { dbMock } = vi.hoisted(() => ({ dbMock: {} as Record<string, unknown> }));

vi.mock('$lib/server/db', () => ({ db: dbMock }));

import { isPgAcceptableTimeZone } from './pg-timezone';

describe('isPgAcceptableTimeZone (batch-5 tz closure)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('true when pg_timezone_names returns the row', async () => {
		const execute = vi.fn(async () => [{ '?column?': 1 }]);
		await expect(isPgAcceptableTimeZone('Asia/Taipei', { execute })).resolves.toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it('false when the name is absent (PG-rejected, e.g. Japan)', async () => {
		const execute = vi.fn(async () => []);
		await expect(isPgAcceptableTimeZone('Japan', { execute })).resolves.toBe(false);
	});

	it('binds the name as a parameter, never string-interpolated', async () => {
		const execute = vi.fn(async () => []);
		const nasty = `x' or '1'='1`;
		await isPgAcceptableTimeZone(nasty, { execute });
		const [query] = execute.mock.calls[0] as unknown as [SQL];
		// Real-dialect render (review lesson: assert the rendered SQL, not
		// hand-written SQL or internal property guesses).
		const rendered = new PgDialect().sqlToQuery(query);
		expect(rendered.sql).not.toContain(nasty);
		expect(rendered.sql).toContain('pg_timezone_names');
		expect(rendered.params).toContain(nasty);
	});

	it('falls back to the app db when no executor is injected', async () => {
		const execute = vi.fn(async () => []);
		dbMock.execute = execute;
		await expect(isPgAcceptableTimeZone('UTC')).resolves.toBe(false);
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
