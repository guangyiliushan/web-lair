import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbStub, envStub } = vi.hoisted(() => ({
	dbStub: { select: vi.fn(), insert: vi.fn(), delete: vi.fn() },
	envStub: {} as Record<string, string | undefined>
}));
vi.mock('$lib/server/db', () => ({ db: dbStub }));
vi.mock('$lib/server/db/system', () => ({
	emailSuppressions: { emailHash: 'email_hash', reason: 'reason', source: 'source' }
}));
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
	envStub.SUPPRESSION_HMAC_KEY = KEY;
});

describe('suppression hashing', () => {
	it('uses the keyed hash when a key is configured', () => {
		const keyed = suppressionHash('reader@example.com');
		expect(keyed).toMatch(/^[0-9a-f]{64}$/);
		expect(suppressionHash('reader@example.com')).toBe(keyed);
		expect(suppressionHash('other@example.com')).not.toBe(keyed);
	});

	it('fails closed when the key is missing', () => {
		delete envStub.SUPPRESSION_HMAC_KEY;
		expect(() => suppressionHash('reader@example.com')).toThrow(/SUPPRESSION_HMAC_KEY is missing/);
	});
});

describe('suppression records', () => {
	it('reads the reason for an address', async () => {
		dbStub.select.mockReturnValueOnce({
			from: () => ({ where: () => ({ limit: async () => [{ reason: 'bounced' }] }) })
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
		expect(conflict.set.reason).toBeDefined();
		expect(conflict.set.source).toBeDefined();
	});

	it('lifts only the soft unsubscribe record', async () => {
		const where = vi.fn(async () => undefined);
		dbStub.delete.mockReturnValueOnce({ where });
		await liftUnsubscribedSuppression('reader@example.com');
		expect(where).toHaveBeenCalledTimes(1);
	});
});
