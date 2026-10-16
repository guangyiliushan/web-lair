import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the notification Webhooks actions. J-3 covered the
 * retry action (guard first, uuid guard, only failed deliveries retry,
 * disabled endpoints refused, a successful retry inserts a NEW queued row
 * copying webhookId/event/payload - the failed row stays for the record).
 *
 * SY S2 adds endpoint CRUD: every action runs `requireAdminRole` first, form
 * validation happens before any DB access, names are soft-rejected
 * case-insensitively (no DB constraint - the G3 ruling), secrets are
 * server-generated `whsec_` values revealed exactly once, and the update
 * write set is asserted EXACTLY (secret/isEnabled must stay untouched).
 */

const { mocks, state } = vi.hoisted(() => {
	const state = {
		selectQueue: [] as unknown[][],
		insertValues: [] as unknown[],
		insertRows: [{ id: 'new-delivery' }] as unknown[],
		insertError: null as Error | null,
		updateSets: [] as unknown[],
		updateRows: [{ id: 'updated-row' }] as unknown[],
		deleteRows: [{ id: 'deleted-row' }] as unknown[]
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
		}),
		update: () => ({
			set: (values: unknown) => {
				state.updateSets.push(values);
				return { where: () => ({ returning: async () => state.updateRows }) };
			}
		}),
		delete: () => ({
			where: () => ({ returning: async () => state.deleteRows })
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
const WEBHOOK_ID = '11111111-1111-7111-8111-111111111111';

function makeFormData(fields: Record<string, string | string[]>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		if (Array.isArray(value)) for (const item of value) body.append(key, item);
		else body.set(key, value);
	}
	return body;
}

function makeEvent(fields: Record<string, string | string[]>) {
	return {
		request: new Request('http://x/admin/settings/notification', {
			method: 'POST',
			body: makeFormData(fields)
		}),
		locals: { user: { id: 'admin-1' } }
	};
}

async function callAction(name: string, fields: Record<string, string | string[]>) {
	try {
		const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[name];
		const result = (await fn(makeEvent(fields) as never)) as Record<string, unknown>;
		return { result, thrown: undefined as unknown };
	} catch (thrown) {
		return { result: undefined, thrown };
	}
}

function callRetry(fields: Record<string, string | string[]>) {
	return callAction('retry', fields);
}

describe('notification webhooks retry', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.selectQueue = [];
		state.insertValues = [];
		state.insertRows = [{ id: 'new-delivery' }];
		state.insertError = null;
		state.updateSets = [];
		state.updateRows = [{ id: 'updated-row' }];
		state.deleteRows = [{ id: 'deleted-row' }];
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
		expect(state.insertValues[0]).toEqual({
			webhookId: 'w1',
			event: 'comment.created',
			payload: { a: 1 },
			status: 'queued'
		});
	});
});

describe('notification webhook endpoint CRUD (SY S2)', () => {
	const validForm = {
		name: 'ops',
		payloadUrl: 'https://example.com/hook',
		events: ['job.run', 'schedule.toggle']
	};

	beforeEach(() => {
		vi.clearAllMocks();
		state.selectQueue = [];
		state.insertValues = [];
		state.insertRows = [{ id: 'new-delivery' }];
		state.insertError = null;
		state.updateSets = [];
		state.updateRows = [{ id: 'updated-row' }];
		state.deleteRows = [{ id: 'deleted-row' }];
	});

	it('every CRUD action runs requireAdminRole first', async () => {
		for (const name of ['create', 'update', 'remove', 'toggle', 'rotate']) {
			guardMock.mockRejectedValueOnce(new Error('redirect: no session'));
			const { thrown } = await callAction(name, {
				id: WEBHOOK_ID,
				name: 'ops',
				payloadUrl: 'https://example.com/hook',
				enabled: 'true',
				events: 'job.run'
			});
			expect(thrown).toBeInstanceOf(Error);
		}
		expect(state.insertValues).toHaveLength(0);
		expect(state.updateSets).toHaveLength(0);
		expect(state.selectQueue).toHaveLength(0);
	});

	it('create validates name/url/events before any db work', async () => {
		const missingName = await callAction('create', { ...validForm, name: '   ' });
		expect(missingName.result).toMatchObject({ status: 400, data: { op: 'create' } });
		const badProtocol = await callAction('create', {
			...validForm,
			payloadUrl: 'ftp://example.com/hook'
		});
		expect(badProtocol.result).toMatchObject({ status: 400 });
		const malformed = await callAction('create', { ...validForm, payloadUrl: 'not a url' });
		expect(malformed.result).toMatchObject({ status: 400 });
		const unknownEvent = await callAction('create', {
			...validForm,
			events: ['page.saved']
		});
		expect(unknownEvent.result).toMatchObject({ status: 400 });
		expect(state.selectQueue).toHaveLength(0);
		expect(state.insertValues).toHaveLength(0);
	});

	it('create soft-rejects a duplicate name (case-insensitive, G3)', async () => {
		state.selectQueue.push([{ id: 'existing' }]);
		const { result } = await callAction('create', validForm);
		expect(result).toMatchObject({ status: 400, data: { op: 'create' } });
		expect(state.insertValues).toHaveLength(0);
	});

	it('create inserts a generated whsec_ secret and reveals it exactly once', async () => {
		state.insertRows = [{ id: WEBHOOK_ID }];
		const { result } = await callAction('create', validForm);
		expect(result).toMatchObject({ op: 'create', created: true, id: WEBHOOK_ID });
		const inserted = state.insertValues[0] as Record<string, unknown>;
		expect(inserted.name).toBe('ops');
		expect(inserted.payloadUrl).toBe('https://example.com/hook');
		expect(inserted.events).toEqual(['job.run', 'schedule.toggle']);
		expect(String(inserted.secret)).toMatch(/^whsec_[A-Za-z0-9+/=]+$/);
		expect(result?.secret).toBe(inserted.secret);
	});

	it('create dedupes repeated event fields', async () => {
		state.insertRows = [{ id: WEBHOOK_ID }];
		await callAction('create', { ...validForm, events: ['job.run', 'job.run'] });
		expect((state.insertValues[0] as { events: string[] }).events).toEqual(['job.run']);
	});

	it('update validates the id and form before any db work', async () => {
		const badId = await callAction('update', { ...validForm, id: 'nope' });
		expect(badId.result).toMatchObject({ status: 400, data: { op: 'update' } });
		const badUrl = await callAction('update', {
			...validForm,
			id: WEBHOOK_ID,
			payloadUrl: '//missing-base'
		});
		expect(badUrl.result).toMatchObject({ status: 400 });
		expect(state.updateSets).toHaveLength(0);
	});

	it('update soft-rejects a duplicate name excluding self, then 404s a vanished row', async () => {
		state.selectQueue.push([{ id: 'other' }]);
		const dup = await callAction('update', { ...validForm, id: WEBHOOK_ID });
		expect(dup.result).toMatchObject({ status: 400, data: { op: 'update' } });
		expect(state.updateSets).toHaveLength(0);

		state.selectQueue.push([]);
		state.updateRows = [];
		const gone = await callAction('update', { ...validForm, id: WEBHOOK_ID });
		expect(gone.result).toMatchObject({ status: 404, data: { op: 'update' } });
	});

	it('update writes ONLY the editable columns (secret/isEnabled untouched)', async () => {
		state.selectQueue.push([]);
		const { result } = await callAction('update', { ...validForm, id: WEBHOOK_ID });
		expect(result).toMatchObject({ op: 'update', updated: true });
		expect(state.updateSets[0]).toEqual({
			name: 'ops',
			payloadUrl: 'https://example.com/hook',
			events: ['job.run', 'schedule.toggle']
		});
	});

	it('remove guards the id, 404s a vanished endpoint and succeeds otherwise', async () => {
		const badId = await callAction('remove', { id: 'nope' });
		expect(badId.result).toMatchObject({ status: 400, data: { op: 'remove' } });
		state.deleteRows = [];
		const gone = await callAction('remove', { id: WEBHOOK_ID });
		expect(gone.result).toMatchObject({ status: 404, data: { op: 'remove' } });
		state.deleteRows = [{ id: WEBHOOK_ID }];
		const ok = await callAction('remove', { id: WEBHOOK_ID });
		expect(ok.result).toMatchObject({ op: 'remove', removed: true });
	});

	it('toggle demands an explicit boolean and writes the desired state', async () => {
		const bad = await callAction('toggle', { id: WEBHOOK_ID, enabled: 'yes' });
		expect(bad.result).toMatchObject({ status: 400, data: { op: 'toggle' } });
		expect(state.updateSets).toHaveLength(0);

		const off = await callAction('toggle', { id: WEBHOOK_ID, enabled: 'false' });
		expect(off.result).toMatchObject({ op: 'toggle', toggled: true });
		expect(state.updateSets[0]).toEqual({ isEnabled: false });

		state.updateRows = [];
		const gone = await callAction('toggle', { id: WEBHOOK_ID, enabled: 'true' });
		expect(gone.result).toMatchObject({ status: 404, data: { op: 'toggle' } });
	});

	it('rotate guards the id, replaces the secret and reveals the new one once', async () => {
		const badId = await callAction('rotate', { id: '' });
		expect(badId.result).toMatchObject({ status: 400, data: { op: 'rotate' } });
		const { result } = await callAction('rotate', { id: WEBHOOK_ID });
		expect(result).toMatchObject({ op: 'rotate', rotated: true });
		const set = state.updateSets[0] as { secret: string };
		expect(set.secret).toMatch(/^whsec_[A-Za-z0-9+/=]+$/);
		expect(result?.secret).toBe(set.secret);
		state.updateRows = [];
		const gone = await callAction('rotate', { id: WEBHOOK_ID });
		expect(gone.result).toMatchObject({ status: 404, data: { op: 'rotate' } });
	});
});
