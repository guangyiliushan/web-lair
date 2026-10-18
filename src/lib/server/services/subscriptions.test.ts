import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pure helpers of the subscription service (D-2). The DB state machine is
 * exercised end-to-end by `e2e/subscribe.e2e.ts` against the real schema; here
 * we pin the input contract so a loosened regex cannot slip through.
 */
const { dbStub, envStub } = vi.hoisted(() => ({
	dbStub: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
	envStub: {} as Record<string, string | undefined>
}));
vi.mock('$lib/server/db', () => ({ db: dbStub }));
vi.mock('$lib/server/db/system', () => ({ subscriptions: {} }));
vi.mock('$env/dynamic/private', () => ({ env: envStub }));
// The service builds predicates only; the chain stubs ignore their arguments.
vi.mock('drizzle-orm', () => ({
	eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
	and: (...parts: unknown[]) => ({ op: 'and', parts }),
	ne: (column: unknown, value: unknown) => ({ op: 'ne', column, value }),
	gte: (column: unknown, value: unknown) => ({ op: 'gte', column, value })
}));

import {
	confirmSubscription,
	discardPendingToken,
	isSubscriptionLang,
	isSubscriptionToken,
	newSubscriptionToken,
	normalizeEmail,
	requestSubscription,
	subscribeAddressKey,
	subscriptionByToken,
	subscriptionTokenTtlMs,
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

beforeEach(() => {
	for (const fn of Object.values(dbStub)) fn.mockReset();
	delete envStub.SUBSCRIBE_HMAC_KEY;
});

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

describe('confirmation token TTL', () => {
	const TTL_TOKEN = 'a'.repeat(43);

	it('defaults to 24h and ignores nonsense values', () => {
		const oneDay = 24 * 60 * 60 * 1000;
		expect(subscriptionTokenTtlMs(undefined)).toBe(oneDay);
		expect(subscriptionTokenTtlMs('')).toBe(oneDay);
		expect(subscriptionTokenTtlMs('0')).toBe(oneDay);
		expect(subscriptionTokenTtlMs('-1')).toBe(oneDay);
		expect(subscriptionTokenTtlMs('nope')).toBe(oneDay);
		expect(subscriptionTokenTtlMs('2')).toBe(2 * oneDay);
	});

	it('clamps an over-long env value to 72h and warns once', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(subscriptionTokenTtlMs('7')).toBe(3 * 24 * 60 * 60 * 1000);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('72h'));
		expect(subscriptionTokenTtlMs('7')).toBe(3 * 24 * 60 * 60 * 1000);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('marks a stale pending row expired but leaves a fresh one alone', async () => {
		const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		dbStub.select.mockReturnValueOnce(
			selectRows([{ status: 'pending', email: 'a@b.c', token: TTL_TOKEN, updatedAt: stale }])
		);
		expect(await subscriptionByToken(TTL_TOKEN)).toEqual({
			status: 'pending',
			email: 'a@b.c',
			expired: true
		});

		dbStub.select.mockReturnValueOnce(
			selectRows([
				{
					status: 'pending',
					email: 'a@b.c',
					token: TTL_TOKEN,
					updatedAt: new Date(Date.now() - 60_000)
				}
			])
		);
		expect(await subscriptionByToken(TTL_TOKEN)).toEqual({
			status: 'pending',
			email: 'a@b.c',
			expired: false
		});
	});

	it('reports expired (not invalid) when the guarded confirm misses on age', async () => {
		dbStub.update.mockReturnValueOnce(updateRows([]));
		dbStub.select.mockReturnValueOnce(
			selectRows([
				{
					status: 'pending',
					email: 'a@b.c',
					token: TTL_TOKEN,
					updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
				}
			])
		);
		expect(await confirmSubscription(TTL_TOKEN)).toBe('expired');
	});

	it('a resubmit rotates a stale pending row and sends a fresh link', async () => {
		dbStub.select.mockReturnValueOnce(
			selectRows([
				{
					id: 1,
					status: 'pending',
					token: 'old',
					lang: 'en',
					source: 'footer',
					verifiedAt: null,
					unsubscribedAt: null,
					updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
				}
			])
		);
		dbStub.update.mockReturnValueOnce(updateRows([{ id: 1 }]));
		const outcome = await requestSubscription({ email: 'a@b.c', lang: 'en', source: 'footer' });
		expect(outcome.kind).toBe('pending');
		if (outcome.kind === 'pending') expect(outcome.send).toBe(true);
	});
});

describe('addressed subscribe cap', () => {
	it('returns null without a key (explicit degradation, no plaintext bucket)', () => {
		delete envStub.SUBSCRIBE_HMAC_KEY;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(subscribeAddressKey('reader@example.com')).toBeNull();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('SUBSCRIBE_HMAC_KEY'));
		warn.mockRestore();
	});

	it('hashes stably and follows a key rotation', () => {
		envStub.SUBSCRIBE_HMAC_KEY = Buffer.alloc(32, 7).toString('base64');
		const first = subscribeAddressKey('reader@example.com');
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(subscribeAddressKey('reader@example.com')).toBe(first);
		expect(subscribeAddressKey('other@example.com')).not.toBe(first);

		envStub.SUBSCRIBE_HMAC_KEY = Buffer.alloc(32, 9).toString('base64');
		expect(subscribeAddressKey('reader@example.com')).not.toBe(first);
	});
});
