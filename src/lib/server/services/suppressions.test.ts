import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbStub, envStub } = vi.hoisted(() => ({
	dbStub: { select: vi.fn(), insert: vi.fn(), delete: vi.fn() },
	envStub: {} as Record<string, string | undefined>
}));
vi.mock('$lib/server/db', () => ({ db: dbStub }));
vi.mock('$lib/server/db/system', () => ({ emailSuppressions: {} }));
vi.mock('$env/dynamic/private', () => ({ env: envStub }));

import {
	liftUnsubscribedSuppression,
	suppress,
	suppressionHash,
	suppressionReason
} from './suppressions';

const KEY = Buffer.alloc(32, 7).toString('base64');

beforeEach(() => {
	for (const fn of Object.values(dbStub)) fn.mockReset();
	delete envStub.SUPPRESSION_HMAC_KEY;
});

describe('suppression hashing', () => {
	it('uses the keyed hash when a key is configured', () => {
		envStub.SUPPRESSION_HMAC_KEY = KEY;
		const keyed = suppressionHash('reader@example.com');
		expect(keyed).toMatch(/^[0-9a-f]{64}$/);
		expect(suppressionHash('reader@example.com')).toBe(keyed);
		expect(suppressionHash('other@example.com')).not.toBe(keyed);
	});

	it('falls back to SHA-256 with a loud log when the key is missing', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(suppressionHash('reader@example.com')).toMatch(/^[0-9a-f]{64}$/);
		expect(error).toHaveBeenCalledWith(expect.stringContaining('SUPPRESSION_HMAC_KEY'));
		error.mockRestore();
	});
});

describe('suppression records', () => {
	it('reads the reason for an address', async () => {
		dbStub.select.mockReturnValueOnce({
			from: () => ({ where: () => ({ limit: async () => [{ reason: 'bounced' }] }) })
		});
		expect(await suppressionReason('reader@example.com')).toBe('bounced');
	});

	it('inserts idempotently and never rewrites the first reason', async () => {
		const onConflictDoNothing = vi.fn(async () => undefined);
		const values = vi.fn(() => ({ onConflictDoNothing }));
		dbStub.insert.mockReturnValueOnce({ values });
		await suppress('reader@example.com', 'complained', 'mail-events');
		expect(values).toHaveBeenCalledWith(
			expect.objectContaining({ reason: 'complained', source: 'mail-events' })
		);
		expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
	});

	it('lifts only the soft unsubscribe record', async () => {
		const where = vi.fn(async () => undefined);
		dbStub.delete.mockReturnValueOnce({ where });
		await liftUnsubscribedSuppression('reader@example.com');
		expect(where).toHaveBeenCalledTimes(1);
	});
});
