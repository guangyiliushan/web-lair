import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the notification Webhooks retry action (J-3): guard
 * first, uuid guard, only failed deliveries retry, disabled endpoints are
 * refused, and a successful retry inserts a NEW queued row copying
 * webhookId/event/payload (the failed row stays for the record).
 */

const { mocks, state } = vi.hoisted(() => {
	const state = {
		selectQueue: [] as unknown[][],
		insertValues: [] as unknown[],
		insertRows: [{ id: 'new-delivery' }] as unknown[],
		insertError: null as Error | null
	};
	const mocks = {
		requireAdminRole: vi.fn(async () => {})
	};
	return { mocks, state };
});

vi.mock('$lib/server/db', () => {
	const makeSelect = () => ({
		from: () => ({
			orderBy: async () => state.selectQueue.shift() ?? [],
			where: () => ({
				limit: async () => state.selectQueue.shift() ?? []
			})
		})
	});
	const db = {
		select: makeSelect,
		insert: () => ({
			values: (values: unknown) => {
				state.insertValues.push(values);
				return {
					returning: async () => {
						if (state.insertError) throw state.insertError;
						return state.insertRows;
					}
				};
			}
		})
	};
	return { db };
});
vi.mock('$lib/server/db/system', () => ({ webhooks: {}, webhookDeliveries: {} }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: mocks.requireAdminRole }));
vi.mock('$lib/server/config/options-registry', () => ({ getOption: vi.fn(async () => 'Etc/UTC') }));

import { actions, load } from './+page.server';

const guardMock = vi.mocked(mocks.requireAdminRole);
const DELIVERY_ID = '33333333-3333-7333-8333-333333333333';

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://x/admin/settings/notification', { method: 'POST', body }),
		locals: { user: { id: 'admin-1' } }
	};
}

async function callRetry(fields: Record<string, string>) {
	try {
		const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>).retry;
		const result = (await fn(makeEvent(fields) as never)) as Record<string, unknown>;
		return { result, thrown: undefined as unknown };
	} catch (thrown) {
		return { result: undefined, thrown };
	}
}

describe('notification webhooks retry', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.selectQueue = [];
		state.insertValues = [];
		state.insertRows = [{ id: 'new-delivery' }];
		state.insertError = null;
	});

	it('runs requireAdminRole first', async () => {
		guardMock.mockRejectedValueOnce(new Error('redirect: no session'));
		const { thrown } = await callRetry({ id: DELIVERY_ID });
		expect(thrown).toBeInstanceOf(Error);
		expect(state.insertValues).toHaveLength(0);
	});

	it('rejects malformed ids before touching the db', async () => {
		const bad = await callRetry({ id: 'nope' });
		expect(bad.result).toMatchObject({ status: 400 });
		expect(state.selectQueue).toHaveLength(0);
	});

	it('404s unknown deliveries and refuses non-failed rows', async () => {
		state.selectQueue.push([]);
		expect((await callRetry({ id: DELIVERY_ID })).result).toMatchObject({ status: 404 });

		state.selectQueue.push([
			{
				id: DELIVERY_ID,
				webhookId: 'w1',
				event: 'comment.created',
				payload: {},
				status: 'succeeded'
			}
		]);
		expect((await callRetry({ id: DELIVERY_ID })).result).toMatchObject({ status: 400 });
		expect(state.insertValues).toHaveLength(0);
	});

	it('refuses retries against missing or disabled endpoints', async () => {
		state.selectQueue.push([
			{
				id: DELIVERY_ID,
				webhookId: 'w1',
				event: 'comment.created',
				payload: { a: 1 },
				status: 'failed'
			}
		]);
		state.selectQueue.push([]);
		expect((await callRetry({ id: DELIVERY_ID })).result).toMatchObject({ status: 404 });

		state.selectQueue.push([
			{
				id: DELIVERY_ID,
				webhookId: 'w1',
				event: 'comment.created',
				payload: { a: 1 },
				status: 'failed'
			}
		]);
		state.selectQueue.push([{ isEnabled: false }]);
		expect((await callRetry({ id: DELIVERY_ID })).result).toMatchObject({ status: 400 });
		expect(state.insertValues).toHaveLength(0);
	});

	it('maps a 23503 (endpoint deleted mid-flight) to 400 (J-3 review P3-1)', async () => {
		state.selectQueue.push([
			{ id: DELIVERY_ID, webhookId: 'w1', event: 'comment.created', payload: {}, status: 'failed' }
		]);
		state.selectQueue.push([{ isEnabled: true }]);
		state.insertError = Object.assign(new Error('fk'), { cause: { code: '23503' } });
		const { result } = await callRetry({ id: DELIVERY_ID });
		expect(result).toMatchObject({ status: 400 });
	});

	it('load requires the admin role first (J-3 review I1)', async () => {
		guardMock.mockRejectedValueOnce(new Error('redirect: no session'));
		await expect(load({} as never)).rejects.toThrow('redirect: no session');
	});

	it('copies the failed row into a fresh queued delivery', async () => {
		state.selectQueue.push([
			{
				id: DELIVERY_ID,
				webhookId: 'w1',
				event: 'comment.created',
				payload: { a: 1 },
				status: 'failed'
			}
		]);
		state.selectQueue.push([{ isEnabled: true }]);
		const ok = await callRetry({ id: DELIVERY_ID });
		expect(ok.result).toMatchObject({ retried: true, id: 'new-delivery' });
		expect(state.insertValues[0]).toMatchObject({
			webhookId: 'w1',
			event: 'comment.created',
			payload: { a: 1 },
			status: 'queued'
		});
	});
});
