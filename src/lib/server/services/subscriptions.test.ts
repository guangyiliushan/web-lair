import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pure helpers of the subscription service (D-2). The DB state machine is
 * exercised end-to-end by `e2e/subscribe.e2e.ts` against the real schema; here
 * we pin the input contract so a loosened regex cannot slip through.
 */
const { dbStub, envStub, suppressionMocks } = vi.hoisted(() => ({
	dbStub: {
		select: vi.fn(),
		insert: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
		transaction: vi.fn()
	},
	envStub: {} as Record<string, string | undefined>,
	suppressionMocks: {
		suppressionReason: vi.fn(),
		suppress: vi.fn(),
		liftUnsubscribedSuppression: vi.fn()
	}
}));
vi.mock('$lib/server/db', () => ({ db: dbStub }));
vi.mock('$lib/server/db/system', () => ({ subscriptions: {}, emailSuppressions: {} }));
vi.mock('$env/dynamic/private', () => ({ env: envStub }));
vi.mock('./suppressions', () => suppressionMocks);
// The service builds predicates only; the chain stubs ignore their arguments.
vi.mock('drizzle-orm', () => ({
	eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
	and: (...parts: unknown[]) => ({ op: 'and', parts }),
	or: (...parts: unknown[]) => ({ op: 'or', parts }),
	ne: (column: unknown, value: unknown) => ({ op: 'ne', column, value }),
	gte: (column: unknown, value: unknown) => ({ op: 'gte', column, value }),
	isNull: (column: unknown) => ({ op: 'isNull', column })
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
import { hashSubscriptionToken } from './subscription-token';

/** A distinct object so a suppression write outside the transaction fails. */
const txStub = {
	select: dbStub.select,
	insert: dbStub.insert,
	update: dbStub.update,
	delete: dbStub.delete,
	transaction: dbStub.transaction
};

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
function selectCapture(rows: unknown[]) {
	const wheres: unknown[] = [];
	return {
		wheres,
		chain: {
			from: () => ({
				where: (predicate: unknown) => {
					wheres.push(predicate);
					return { limit: async () => rows };
				}
			})
		}
	};
}
function deleteRows(rows: unknown[]) {
	return { where: () => ({ returning: async () => rows }) };
}
function updateWhereCapture() {
	const sets: unknown[] = [];
	const wheres: unknown[] = [];
	return {
		sets,
		wheres,
		chain: {
			set: (values: unknown) => {
				sets.push(values);
				return {
					where: (predicate: unknown) => {
						wheres.push(predicate);
						return { returning: async () => [] };
					}
				};
			}
		}
	};
}

beforeEach(() => {
	for (const fn of Object.values(dbStub)) fn.mockReset();
	dbStub.transaction.mockImplementation(async (fn: (tx: typeof dbStub) => unknown) => fn(txStub));
	suppressionMocks.suppressionReason.mockReset();
	suppressionMocks.suppressionReason.mockResolvedValue(null);
	suppressionMocks.suppress.mockReset();
	suppressionMocks.suppress.mockResolvedValue(undefined);
	suppressionMocks.liftUnsubscribedSuppression.mockReset();
	suppressionMocks.liftUnsubscribedSuppression.mockResolvedValue(undefined);
	delete envStub.SUBSCRIBE_HMAC_KEY;
});

describe('subscription transitions (stubbed db)', () => {
	const TOKEN = 'a'.repeat(43);

	it('confirm reports the state a zero-row update actually left behind', async () => {
		dbStub.update.mockReturnValueOnce(updateRows([]));
		dbStub.select.mockReturnValueOnce(
			selectRows([{ id: 's1', status: 'unsubscribed', email: 'a@b.c' }])
		);
		expect(await confirmSubscription(TOKEN)).toBe('unsubscribed');

		dbStub.update.mockReturnValueOnce(updateRows([]));
		dbStub.select.mockReturnValueOnce(selectRows([]));
		dbStub.select.mockReturnValueOnce(selectRows([]));
		expect(await confirmSubscription(TOKEN)).toBe('invalid');
	});

	it('confirm reports subscribed only when a row was written', async () => {
		dbStub.update.mockReturnValueOnce(updateRows([{ id: 1 }]));
		expect(await confirmSubscription(TOKEN)).toBe('subscribed');
	});

	it('confirm lifts a soft suppression when the write returns the address', async () => {
		dbStub.update.mockReturnValueOnce(updateRows([{ id: 1, email: 'reader@example.com' }]));
		expect(await confirmSubscription(TOKEN)).toBe('subscribed');
		expect(suppressionMocks.liftUnsubscribedSuppression).toHaveBeenCalledWith(
			'reader@example.com',
			txStub
		);
	});

	it('unsubscribe deletes a pending row and records the suppression in one transaction', async () => {
		dbStub.delete.mockReturnValueOnce(deleteRows([{ email: 'a@b.c' }]));
		expect(await unsubscribe(TOKEN)).toBe('unsubscribed');
		expect(dbStub.transaction).toHaveBeenCalledTimes(1);
		expect(suppressionMocks.suppress).toHaveBeenCalledWith(
			'a@b.c',
			'unsubscribed',
			'unsubscribe-page',
			txStub
		);
	});

	it('unsubscribe updates a confirmed row and records the suppression', async () => {
		dbStub.delete.mockReturnValueOnce(deleteRows([]));
		dbStub.update.mockReturnValueOnce(updateRows([{ email: 'a@b.c' }]));
		expect(await unsubscribe(TOKEN)).toBe('unsubscribed');
		expect(suppressionMocks.suppress).toHaveBeenCalledWith(
			'a@b.c',
			'unsubscribed',
			'unsubscribe-page',
			txStub
		);
	});

	it('unsubscribe reports already-unsubscribed and repairs the suppression row', async () => {
		dbStub.delete.mockReturnValueOnce(deleteRows([]));
		dbStub.update.mockReturnValueOnce(updateRows([]));
		dbStub.select.mockReturnValueOnce(selectRows([{ status: 'unsubscribed', email: 'a@b.c' }]));
		expect(await unsubscribe(TOKEN)).toBe('already-unsubscribed');
		expect(suppressionMocks.suppress).toHaveBeenCalledWith(
			'a@b.c',
			'unsubscribed',
			'unsubscribe-page',
			txStub
		);
	});

	it('unsubscribe reports invalid when both guarded writes and the read miss', async () => {
		dbStub.delete.mockReturnValueOnce(deleteRows([]));
		dbStub.update.mockReturnValueOnce(updateRows([]));
		dbStub.select.mockReturnValueOnce(selectRows([]));
		expect(await unsubscribe(TOKEN)).toBe('invalid');
		expect(suppressionMocks.suppress).not.toHaveBeenCalled();
	});

	it('a lost resubmit CAS returns the winner token without sending', async () => {
		const stale = new Date(Date.now() - 60 * 60 * 1000);
		dbStub.select
			.mockReturnValueOnce(
				selectRows([{ id: 1, status: 'pending', token: 'old', updatedAt: stale }])
			)
			.mockReturnValueOnce(selectRows([{ id: 1, status: 'pending', token: 'old' }]));
		const capture = updateWhereCapture();
		dbStub.update.mockReturnValueOnce(capture.chain);
		await expect(
			requestSubscription({ email: 'a@b.c', lang: 'en', source: 'footer' })
		).resolves.toEqual({ kind: 'pending', token: 'old', send: false });

		// The rotation must be hash-first with a plaintext fallback; a CAS that
		// only compares `token` would break once that column is dropped.
		const guard = capture.wheres[0] as { op: string; parts: unknown[] };
		expect(guard.op).toBe('and');
		const credential = guard.parts.find(
			(part): part is { op: string; parts: unknown[] } =>
				typeof part === 'object' && part !== null && (part as { op?: string }).op === 'or'
		);
		expect(credential).toBeDefined();
		expect(credential!.parts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ op: 'eq', value: 'old' }),
				expect.objectContaining({ op: 'eq', value: hashSubscriptionToken('old') })
			])
		);
	});

	it('refuses a hard-bounced address without touching the subscription row', async () => {
		suppressionMocks.suppressionReason.mockResolvedValueOnce('bounced');
		await expect(
			requestSubscription({ email: 'a@b.c', lang: 'en', source: 'footer' })
		).resolves.toEqual({ kind: 'suppressed' });
		expect(dbStub.select).not.toHaveBeenCalled();
	});

	it('allows a self-submitted form after a soft unsubscribe (D-1)', async () => {
		suppressionMocks.suppressionReason.mockResolvedValueOnce('unsubscribed');
		dbStub.select.mockReturnValueOnce(selectRows([]));
		dbStub.insert.mockReturnValueOnce({ values: async () => undefined });
		await expect(
			requestSubscription({ email: 'a@b.c', lang: 'en', source: 'footer' })
		).resolves.toMatchObject({ kind: 'pending', send: true });
	});

	it('discard deletes only through a guarded where clause', async () => {
		dbStub.delete.mockReturnValueOnce({ where: vi.fn(async () => undefined) });
		await discardPendingToken(TOKEN);
		expect(dbStub.delete).toHaveBeenCalledTimes(1);
	});
});

describe('token hashes (E2-3)', () => {
	const HASH_TOKEN = 'a'.repeat(43);

	it('hashes deterministically to 64 hex characters', async () => {
		const { hashSubscriptionToken } = await import('./subscription-token');
		const one = hashSubscriptionToken(HASH_TOKEN);
		expect(one).toMatch(/^[0-9a-f]{64}$/);
		expect(hashSubscriptionToken(HASH_TOKEN)).toBe(one);
		expect(hashSubscriptionToken('b'.repeat(43))).not.toBe(one);
	});

	it('reads by hash first', async () => {
		const capture = selectCapture([
			{
				id: 's1',
				status: 'pending',
				email: 'a@b.c',
				token: HASH_TOKEN,
				tokenHash: 'f'.repeat(64),
				updatedAt: new Date()
			}
		]);
		dbStub.select.mockReturnValueOnce(capture.chain);
		expect(await subscriptionByToken(HASH_TOKEN)).toMatchObject({ id: 's1', status: 'pending' });
		expect(dbStub.select).toHaveBeenCalledTimes(1);
		// The first read must target token_hash, not the plaintext column.
		expect(capture.wheres[0]).toMatchObject({
			op: 'eq',
			value: expect.stringMatching(/^[0-9a-f]{64}$/)
		});
	});

	it('falls back to the plaintext column and backfills the hash for legacy rows', async () => {
		const issuedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		const hashMiss = selectCapture([]);
		const legacyHit = selectCapture([
			{
				id: 's1',
				status: 'pending',
				email: 'a@b.c',
				token: HASH_TOKEN,
				tokenHash: null,
				updatedAt: issuedAt
			}
		]);
		dbStub.select.mockReturnValueOnce(hashMiss.chain).mockReturnValueOnce(legacyHit.chain);
		const capture = updateWhereCapture();
		dbStub.update.mockReturnValueOnce(capture.chain);
		expect(await subscriptionByToken(HASH_TOKEN)).toMatchObject({ id: 's1', status: 'pending' });
		expect(dbStub.update).toHaveBeenCalledTimes(1);

		// First read by hash, second by plaintext (only for legacy rows).
		expect(hashMiss.wheres[0]).toMatchObject({
			op: 'eq',
			value: expect.stringMatching(/^[0-9a-f]{64}$/)
		});
		expect(legacyHit.wheres[0]).toMatchObject({ op: 'eq', value: HASH_TOKEN });

		// The backfill writes the hash and keeps the TTL anchor; its WHERE
		// guards on id + token_hash IS NULL + plaintext token.
		expect(capture.sets[0]).toMatchObject({
			tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
			updatedAt: issuedAt
		});
		const guard = capture.wheres[0] as { op: string; parts: unknown[] };
		expect(guard.op).toBe('and');
		expect(guard.parts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ op: 'isNull' }),
				expect.objectContaining({ op: 'eq', value: HASH_TOKEN })
			])
		);
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
		expect(subscriptionTokenTtlMs('0.5')).toBe(oneDay);
		expect(subscriptionTokenTtlMs('1e-3')).toBe(oneDay);
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
			selectRows([
				{ id: 's1', status: 'pending', email: 'a@b.c', token: TTL_TOKEN, updatedAt: stale }
			])
		);
		expect(await subscriptionByToken(TTL_TOKEN)).toEqual({
			id: 's1',
			status: 'pending',
			email: 'a@b.c',
			expired: true
		});

		dbStub.select.mockReturnValueOnce(
			selectRows([
				{
					id: 's1',
					status: 'pending',
					email: 'a@b.c',
					token: TTL_TOKEN,
					updatedAt: new Date(Date.now() - 60_000)
				}
			])
		);
		expect(await subscriptionByToken(TTL_TOKEN)).toEqual({
			id: 's1',
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
