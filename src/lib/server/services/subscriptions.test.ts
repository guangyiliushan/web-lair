import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pure helpers of the subscription service (D-2). The DB state machine is
 * exercised end-to-end by `e2e/subscribe.e2e.ts` against the real schema; here
 * we pin the input contract so a loosened regex cannot slip through.
 */
const { dbStub } = vi.hoisted(() => ({
	dbStub: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() }
}));
vi.mock('$lib/server/db', () => ({ db: dbStub }));
vi.mock('$lib/server/db/system', () => ({ subscriptions: {} }));
// The service builds predicates only; the chain stubs ignore their arguments.
vi.mock('drizzle-orm', () => ({
	eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
	and: (...parts: unknown[]) => ({ op: 'and', parts }),
	ne: (column: unknown, value: unknown) => ({ op: 'ne', column, value })
}));

import {
	confirmSubscription,
	discardPendingToken,
	isSubscriptionLang,
	isSubscriptionToken,
	newSubscriptionToken,
	normalizeEmail,
	requestSubscription,
	unsubscribe
} from './subscriptions';

describe('subscription input contract', () => {
	it('normalizes case and surrounding whitespace', () => {
		expect(normalizeEmail('  Reader@Example.COM ')).toBe('reader@example.com');
	});

	it('rejects malformed addresses', () => {
		for (const value of ['', ' ', 'no-at-sign', 'a@b', 'a b@c.d', '@example.com', 'a@.com']) {
			expect(normalizeEmail(value)).toBeNull();
		}
	});

	it('rejects addresses longer than 254 characters', () => {
		const local = 'a'.repeat(250);
		expect(normalizeEmail(`${local}@example.com`)).toBeNull();
	});

	it('mints 32-byte base64url tokens that satisfy the token guard', () => {
		const token = newSubscriptionToken();
		expect(token).toHaveLength(43);
		expect(isSubscriptionToken(token)).toBe(true);
		expect(newSubscriptionToken()).not.toBe(token);
	});

	it('rejects tokens that are not 43 base64url characters', () => {
		expect(isSubscriptionToken('')).toBe(false);
		expect(isSubscriptionToken('short')).toBe(false);
		expect(isSubscriptionToken('a'.repeat(43))).toBe(true);
		expect(isSubscriptionToken('a'.repeat(42) + '!')).toBe(false);
	});

	it('accepts only the three site languages', () => {
		expect(isSubscriptionLang('en')).toBe(true);
		expect(isSubscriptionLang('zh-cn')).toBe(true);
		expect(isSubscriptionLang('ja')).toBe(true);
		expect(isSubscriptionLang('de')).toBe(false);
	});
});

function updateRows(rows: unknown[]) {
	return { set: () => ({ where: () => ({ returning: async () => rows }) }) };
}
function selectRows(rows: unknown[]) {
	return { from: () => ({ where: () => ({ limit: async () => rows }) }) };
}
function deleteRows(rows: unknown[]) {
	return { where: () => ({ returning: async () => rows }) };
}

describe('subscription transitions (stubbed db)', () => {
	const TOKEN = 'a'.repeat(43);

	beforeEach(() => {
		for (const fn of Object.values(dbStub)) fn.mockReset();
	});

	it('confirm reports the state a zero-row update actually left behind', async () => {
		dbStub.update.mockReturnValueOnce(updateRows([]));
		dbStub.select.mockReturnValueOnce(selectRows([{ status: 'unsubscribed', email: 'a@b.c' }]));
		expect(await confirmSubscription(TOKEN)).toBe('unsubscribed');

		dbStub.update.mockReturnValueOnce(updateRows([]));
		dbStub.select.mockReturnValueOnce(selectRows([]));
		expect(await confirmSubscription(TOKEN)).toBe('invalid');
	});

	it('confirm reports subscribed only when a row was written', async () => {
		dbStub.update.mockReturnValueOnce(updateRows([{ id: 1 }]));
		expect(await confirmSubscription(TOKEN)).toBe('subscribed');
	});

	it('unsubscribe tries the pending delete before the subscribed update', async () => {
		dbStub.delete.mockReturnValueOnce(deleteRows([]));
		dbStub.update.mockReturnValueOnce(updateRows([{ id: 1 }]));
		expect(await unsubscribe(TOKEN)).toBe('unsubscribed');
	});

	it('unsubscribe reports already-unsubscribed when both guarded writes miss', async () => {
		dbStub.delete.mockReturnValueOnce(deleteRows([]));
		dbStub.update.mockReturnValueOnce(updateRows([]));
		dbStub.select.mockReturnValueOnce(selectRows([{ status: 'unsubscribed', email: 'a@b.c' }]));
		expect(await unsubscribe(TOKEN)).toBe('already-unsubscribed');
	});

	it('a lost resubmit CAS returns the winner token without sending', async () => {
		const stale = new Date(Date.now() - 60 * 60 * 1000);
		dbStub.select
			.mockReturnValueOnce(
				selectRows([{ id: 1, status: 'pending', token: 'old', updatedAt: stale }])
			)
			.mockReturnValueOnce(selectRows([{ id: 1, status: 'pending', token: 'old' }]));
		dbStub.update.mockReturnValueOnce(updateRows([]));
		await expect(
			requestSubscription({ email: 'a@b.c', lang: 'en', source: 'footer' })
		).resolves.toEqual({ kind: 'pending', token: 'old', send: false });
	});

	it('discard deletes only through a guarded where clause', async () => {
		dbStub.delete.mockReturnValueOnce({ where: vi.fn(async () => undefined) });
		await discardPendingToken(TOKEN);
		expect(dbStub.delete).toHaveBeenCalledTimes(1);
	});
});
