import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';

const { dbStub, envStub } = vi.hoisted(() => ({
	dbStub: { select: vi.fn(), insert: vi.fn(), delete: vi.fn() },
	envStub: {} as Record<string, string | undefined>
}));
vi.mock('$lib/server/db', () => ({ db: dbStub }));
vi.mock('$lib/server/db/system', async () => ({
	...(await import('../db/system/email-suppression.schema'))
}));
vi.mock('$env/dynamic/private', () => ({ env: envStub }));

import {
	liftUnsubscribedSuppression,
	suppress,
	suppressionHash,
	suppressionHashes,
	suppressionReason
} from './suppressions';

const KEY = Buffer.alloc(32, 7).toString('base64');
const dialect = new PgDialect();

function render(query: unknown): { sql: string; params: unknown[] } {
	const rendered = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]);
	return { sql: rendered.sql, params: rendered.params };
}

beforeEach(() => {
	for (const fn of Object.values(dbStub)) fn.mockReset();
	envStub.SUPPRESSION_HMAC_KEY = KEY;
});

describe('suppression hashing', () => {
	it('uses the keyed hash when a key is configured', () => {
		const keyed = suppressionHash('reader@example.com');
		expect(keyed).toMatch(/^[0-9a-f]{64}$/);
		expect(suppressionHash('reader@example.com')).toBe(keyed);
		expect(suppressionHash(' Reader@Example.COM ')).toBe(keyed);
		expect(suppressionHash('other@example.com')).not.toBe(keyed);
	});

	it('hashes legacy addresses the strict form regex rejects without throwing', () => {
		expect(() => suppressionHash('reader@localhost')).not.toThrow();
		expect(suppressionHash(' Reader@Localhost ')).toBe(suppressionHash('reader@localhost'));
		// Pin the value to an independently computed HMAC, not just stability.
		const expected = createHmac('sha256', Buffer.from(KEY, 'base64'))
			.update('reader@localhost')
			.digest('hex');
		expect(suppressionHash(' Reader@Localhost ')).toBe(expected);
	});

	it('fails closed when the key is missing', () => {
		delete envStub.SUPPRESSION_HMAC_KEY;
		expect(() => suppressionHash('reader@example.com')).toThrow(/SUPPRESSION_HMAC_KEY is missing/);
	});
});

describe('suppression records', () => {
	it('reads the reason for an address', async () => {
		dbStub.select.mockReturnValueOnce({
			from: () => ({ where: async () => [{ reason: 'bounced' }] })
		});
		expect(await suppressionReason('reader@example.com')).toBe('bounced');
	});

	it('upserts monotonically and never downgrades a stronger reason', async () => {
		const onConflictDoUpdate = vi.fn(async (config: unknown) => {
			void config;
		});
		const values = vi.fn(() => ({ onConflictDoUpdate }));
		dbStub.insert.mockReturnValueOnce({ values });
		await suppress('reader@example.com', 'complained', 'mail-events');
		expect(values).toHaveBeenCalledWith(
			expect.objectContaining({ reason: 'complained', source: 'mail-events' })
		);
		const conflict = onConflictDoUpdate.mock.calls[0]![0] as {
			target: unknown;
			set: { reason: unknown; source: unknown };
		};
		expect(conflict.target).toBeDefined();

		// The rank CASE is the guarantee: a later, weaker event must not
		// overwrite a complaint. Rendering the expression (instead of only
		// checking it exists) fails if the CASE is replaced by excluded.reason.
		const reason = render(conflict.set.reason);
		expect(reason.sql).toMatch(/case/i);
		expect(reason.sql).toMatch(/complained[\s\S]*bounced/i);
		expect(reason.sql).toContain("'complained'");
		expect(reason.sql).toContain("'bounced'");

		const source = render(conflict.set.source);
		expect(source.sql).toMatch(/case/i);
		expect(source.sql).toMatch(/excluded\.source/i);
		expect(source.sql).toContain("'unsubscribed'");
	});

	it('lifts only the soft unsubscribe record', async () => {
		const where = vi.fn(async (predicate: unknown) => {
			void predicate;
		});
		dbStub.delete.mockReturnValueOnce({ where });
		await liftUnsubscribedSuppression('reader@example.com');
		expect(where).toHaveBeenCalledTimes(1);

		// Dropping the reason predicate would let a confirm delete a
		// complaint/hard bounce; pin the rendered WHERE clause.
		const predicate = render(where.mock.calls[0]![0]);
		expect(predicate.sql).toMatch(/reason/i);
		expect(predicate.params).toContain('unsubscribed');
		// The hash half must survive: dropping it would delete every soft
		// opt-out, not just this address.
		expect(predicate.sql).toContain('email_hash');
		expect(predicate.params).toHaveLength(2);
	});
});

describe('suppression key versions (F-14)', () => {
	it('keeps version 1 byte-identical to the pre-F-14 scheme', () => {
		envStub.SUPPRESSION_HMAC_KEY_VERSION = '1';
		const expected = createHmac('sha256', Buffer.from(KEY, 'base64'))
			.update('reader@example.com')
			.digest('hex');
		const [only] = suppressionHashes('reader@example.com');
		expect(only).toEqual({ version: 1, hash: expected });
	});

	it('derives later versions from the same master key', () => {
		envStub.SUPPRESSION_HMAC_KEY_VERSION = '2';
		const master = Buffer.from(KEY, 'base64');
		const v2Key = createHmac('sha256', master).update('wl:suppression:key:v2').digest();
		const v2Hash = createHmac('sha256', v2Key).update('reader@example.com').digest('hex');
		const hashes = suppressionHashes('reader@example.com');
		expect(hashes).toHaveLength(2);
		expect(hashes[1]).toEqual({ version: 2, hash: v2Hash });
		expect(suppressionHash('reader@example.com')).toBe(v2Hash);
	});

	it('rejects a non-positive or non-integer version instead of silently using 1', () => {
		for (const raw of ['0', '-1', '2.5', 'two']) {
			envStub.SUPPRESSION_HMAC_KEY_VERSION = raw;
			expect(() => suppressionHash('reader@example.com')).toThrow(/SUPPRESSION_HMAC_KEY_VERSION/);
		}
		envStub.SUPPRESSION_HMAC_KEY_VERSION = '1';
	});

	it('reads every version and keeps the strongest reason', async () => {
		envStub.SUPPRESSION_HMAC_KEY_VERSION = '2';
		dbStub.select.mockReturnValueOnce({
			from: () => ({ where: async () => [{ reason: 'unsubscribed' }, { reason: 'complained' }] })
		});
		expect(await suppressionReason('reader@example.com')).toBe('complained');
	});

	it('folds a stale-version row into the active version on write', async () => {
		envStub.SUPPRESSION_HMAC_KEY_VERSION = '2';
		dbStub.select.mockReturnValueOnce({
			from: () => ({
				where: async () => [{ reason: 'bounced', source: 'smtp' }]
			})
		});
		const values = vi.fn(() => ({ onConflictDoUpdate: vi.fn(async () => undefined) }));
		dbStub.insert.mockReturnValueOnce({ values });
		const del = vi.fn(async () => undefined);
		dbStub.delete.mockReturnValueOnce({ where: del });

		await suppress('reader@example.com', 'unsubscribed', 'unsubscribe-page');

		// The stale hard bounce wins over the fresh soft opt-out, and the new
		// row is written at the active version.
		expect(values).toHaveBeenCalledWith(
			expect.objectContaining({ reason: 'bounced', source: 'smtp', keyVersion: 2 })
		);
		expect(del).toHaveBeenCalledTimes(1);
		const predicate = render((del.mock.calls[0] as unknown[])[0]);
		expect(predicate.sql).toContain('email_hash');
	});
});
