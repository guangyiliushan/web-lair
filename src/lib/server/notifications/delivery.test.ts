import { describe, expect, it, vi } from 'vitest';
import { deliverNotification } from './delivery';
import type { JobsDb } from '../jobs/types';
import type { AdapterResult } from './adapters/types';

/**
 * Delivery loop teeth: the claim hands back one due row, the
 * outcome mapping is exact (sent / queued+delay / terminal failed), and the
 * retry schedule is the documented 1m/5m/15m.
 */
interface FakeDeliveryRow {
	id: string;
	eventType: string;
	eventKey: string;
	channel: string;
	attempts: number;
	payload: Record<string, unknown> | null;
}

function fakeDeliveryDb(options: {
	claims: Array<FakeDeliveryRow[]>;
	ownerEmail?: string | null;
	ownerLookupError?: boolean;
}) {
	const state = {
		updates: [] as Array<Record<string, unknown>>,
		selects: 0
	};
	const chain = (result: unknown[]) => {
		const promise = Promise.resolve(result);
		const node: unknown = new Proxy(
			{},
			{
				get(_target, prop) {
					if (prop === 'then') return promise.then.bind(promise);
					return () => node;
				}
			}
		);
		return node;
	};
	const tx = {
		select: () => {
			state.selects += 1;
			// Odd calls are the claim; the email path's owner lookup is even.
			const isClaim = state.selects % 2 === 1 || !options.ownerEmail;
			if (!isClaim && options.ownerLookupError) throw new Error('user table unavailable');
			const rows = isClaim ? (options.claims.shift() ?? []) : [{ email: options.ownerEmail }];
			return chain(rows);
		},
		// Nested transaction = SAVEPOINT; the owner lookup runs inside one so a
		// failing `user` read cannot poison the claim transaction.
		transaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> => fn(tx),
		update: () => ({
			set: (values: Record<string, unknown>) => {
				state.updates.push(values);
				return { where: () => Promise.resolve([]) };
			}
		})
	};
	const db = {
		transaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> => fn(tx)
	} as unknown as JobsDb;
	return { db, state };
}

const NOW = new Date('2026-11-16T10:00:00.000Z');
const deps = (now: Date = NOW) => ({ now: () => now, log: vi.fn() });

function barkRow(overrides: Partial<FakeDeliveryRow> = {}): FakeDeliveryRow {
	return {
		id: 'delivery-1',
		eventType: 'comment.pending',
		eventKey: 'comment:1111',
		channel: 'bark',
		attempts: 0,
		payload: { title: 'New comment', body: 'hello' },
		...overrides
	};
}

const ok: AdapterResult = { ok: true, responseCode: 200 };
const retryable: AdapterResult = {
	ok: false,
	permanent: false,
	error: 'HTTP 503',
	responseCode: 503
};
const permanent: AdapterResult = {
	ok: false,
	permanent: true,
	error: 'bark code 400',
	responseCode: 200
};

describe('deliverNotification', () => {
	it('returns null when nothing is due', async () => {
		const { db } = fakeDeliveryDb({ claims: [[]] });
		expect(await deliverNotification(db, deps())).toBeNull();
	});

	it('marks a successful send `sent` with sent_at and attempts+1', async () => {
		const { db, state } = fakeDeliveryDb({ claims: [[barkRow()]] });
		const outcome = await deliverNotification(db, {
			...deps(),
			sendBark: async () => ok
		});
		expect(outcome).toBe('sent');
		expect(state.updates).toHaveLength(1);
		expect(state.updates[0]).toMatchObject({
			status: 'sent',
			attempts: 1,
			responseCode: 200,
			error: null,
			sentAt: NOW
		});
	});

	it('re-queues a retryable failure with the 1m delay', async () => {
		const { db, state } = fakeDeliveryDb({ claims: [[barkRow()]] });
		const outcome = await deliverNotification(db, {
			...deps(),
			sendBark: async () => retryable
		});
		expect(outcome).toBe('retried');
		expect(state.updates[0]).toMatchObject({ status: 'queued', attempts: 1, responseCode: 503 });
		expect(state.updates[0].nextAttemptAt).toEqual(new Date(NOW.getTime() + 60_000));
	});

	it('uses the 5m delay after the second failure', async () => {
		const { db, state } = fakeDeliveryDb({ claims: [[barkRow({ attempts: 1 })]] });
		await deliverNotification(db, { ...deps(), sendBark: async () => retryable });
		expect(state.updates[0].nextAttemptAt).toEqual(new Date(NOW.getTime() + 300_000));
	});

	it('uses the 15m delay after the third failure', async () => {
		const { db, state } = fakeDeliveryDb({ claims: [[barkRow({ attempts: 2 })]] });
		await deliverNotification(db, { ...deps(), sendBark: async () => retryable });
		expect(state.updates[0]).toMatchObject({ status: 'queued', attempts: 3 });
		expect(state.updates[0].nextAttemptAt).toEqual(new Date(NOW.getTime() + 900_000));
	});

	it('turns the fourth retryable failure terminal', async () => {
		const { db, state } = fakeDeliveryDb({ claims: [[barkRow({ attempts: 3 })]] });
		const outcome = await deliverNotification(db, { ...deps(), sendBark: async () => retryable });
		expect(outcome).toBe('failed');
		expect(state.updates[0]).toMatchObject({ status: 'failed', attempts: 4, sentAt: null });
	});

	it('turns a permanent failure terminal on the first attempt', async () => {
		const { db, state } = fakeDeliveryDb({ claims: [[barkRow()]] });
		const outcome = await deliverNotification(db, { ...deps(), sendBark: async () => permanent });
		expect(outcome).toBe('failed');
		expect(state.updates[0]).toMatchObject({ status: 'failed', attempts: 1 });
	});

	it('treats a throwing adapter as retryable instead of wedging the segment', async () => {
		const { db, state } = fakeDeliveryDb({ claims: [[barkRow()]] });
		const outcome = await deliverNotification(db, {
			...deps(),
			sendBark: async () => {
				throw new Error('adapter exploded on https://bark.example/push?key=secret-key');
			}
		});
		expect(outcome).toBe('retried');
		expect(state.updates[0].status).toBe('queued');
		expect(String(state.updates[0].error)).not.toContain('secret-key');
	});

	it('delivers email to the owner address resolved in the same transaction', async () => {
		const row = barkRow({ channel: 'email' });
		const { db } = fakeDeliveryDb({ claims: [[row], []], ownerEmail: 'owner@lair.example' });
		const sendEmail = vi.fn(async () => ok);
		const outcome = await deliverNotification(db, { ...deps(), sendEmail });
		expect(outcome).toBe('sent');
		expect(sendEmail).toHaveBeenCalledWith('owner@lair.example', row.payload, expect.anything());
	});

	it('records a retryable attempt when the owner lookup fails (the claim tx survives)', async () => {
		const row = barkRow({ channel: 'email' });
		const { db, state } = fakeDeliveryDb({
			claims: [[row]],
			ownerEmail: 'owner@lair.example',
			ownerLookupError: true
		});
		const sendEmail = vi.fn(async () => ok);
		const outcome = await deliverNotification(db, { ...deps(), sendEmail });
		expect(outcome).toBe('retried');
		expect(sendEmail).not.toHaveBeenCalled();
		expect(state.updates[0]).toMatchObject({ status: 'queued', attempts: 1 });
		expect(String(state.updates[0].error)).toContain('owner lookup failed');
	});

	it('records a missing owner as a permanent failure (nothing will ever accept it)', async () => {
		const row = barkRow({ channel: 'email' });
		const { db, state } = fakeDeliveryDb({ claims: [[row]], ownerEmail: null });
		const sendEmail = vi.fn(async (owner: string | null) =>
			owner
				? ok
				: ({ ok: false, permanent: true, error: 'no owner', responseCode: null } as AdapterResult)
		);
		const outcome = await deliverNotification(db, { ...deps(), sendEmail });
		expect(outcome).toBe('failed');
		expect(state.updates[0].status).toBe('failed');
	});
});
