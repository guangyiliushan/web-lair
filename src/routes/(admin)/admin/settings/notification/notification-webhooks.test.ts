import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

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
 *
 * Review round-1 teeth: the mock now records the TARGET TABLE of every
 * write and the WHERE conditions of every select, so a write moved to the
 * wrong table or a lost `lower(...)`/`<>` predicate turns a test red; the
 * stored URL must be the normalized `href`, the load must never ship the
 * raw secret, and the empty selection is pinned as intentional.
 */

const { mocks, state } = vi.hoisted(() => {
	const state = {
		selectQueue: [] as unknown[][],
		insertValues: [] as unknown[],
		insertTables: [] as unknown[],
		insertRows: [{ id: 'new-delivery' }] as unknown[],
		insertError: null as Error | null,
		updateSets: [] as unknown[],
		updateTables: [] as unknown[],
		updateRows: [{ id: 'updated-row' }] as unknown[],
		updateError: null as Error | null,
		updateWheres: [] as unknown[],
		deleteTables: [] as unknown[],
		deleteRows: [{ id: 'deleted-row' }] as unknown[],
		deleteWheres: [] as unknown[],
		selectCount: 0,
		whereConds: [] as unknown[]
	};
	const mocks = {
		requireAdminRole: vi.fn(async () => {})
	};
	return { mocks, state };
});

vi.mock('$lib/server/db', () => {
	const makeSelect = () => ({
		from: () => ({
			orderBy: () => {
				const rows = state.selectQueue.shift() ?? [];
				// The load's endpoints query awaits the orderBy result directly;
				// the deliveries query chains `.limit(50)` after it - support both.
				return Object.assign(rows, { limit: async () => rows });
			},
			where: (cond: unknown) => {
				state.whereConds.push(cond);
				return {
					limit: async () => state.selectQueue.shift() ?? []
				};
			}
		})
	});
	const db = {
		// selectCount makes the "no db work before the guard" assertions real
		// (review round-2 SYT-5: selectQueue-only assertions were tautological).
		select: () => {
			state.selectCount += 1;
			return makeSelect();
		},
		insert: (table: unknown) => {
			state.insertTables.push(table);
			return {
				values: (values: unknown) => {
					state.insertValues.push(values);
					return {
						returning: async () => {
							if (state.insertError) throw state.insertError;
							return state.insertRows;
						}
					};
				}
			};
		},
		update: (table: unknown) => {
			state.updateTables.push(table);
			return {
				set: (values: unknown) => {
					state.updateSets.push(values);
					return {
						where: (cond: unknown) => {
							state.updateWheres.push(cond);
							return {
								returning: async () => {
									if (state.updateError) throw state.updateError;
									return state.updateRows;
								}
							};
						}
					};
				}
			};
		},
		delete: (table: unknown) => {
			state.deleteTables.push(table);
			return {
				where: (cond: unknown) => {
					state.deleteWheres.push(cond);
					return { returning: async () => state.deleteRows };
				}
			};
		}
	};
	return { db };
});
// The whole barrel passes through (round-3 SY3-4): the real tables keep
// their column names for the write-predicate teeth; only the db CLIENT is
// faked (separate mock).
vi.mock('$lib/server/db/system', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/db/system')>();
	return { ...actual };
});
vi.mock('$lib/server/authz', () => ({ requireAdminRole: mocks.requireAdminRole }));
vi.mock('$lib/server/config/options-registry', () => ({ getOption: vi.fn(async () => 'Etc/UTC') }));

import { actions, load } from './+page.server';
import {
	webhookDeliveries as webhookDeliveriesMock,
	webhooks as webhooksMock
} from '$lib/server/db/system';
import { maskWebhookSecret } from '$lib/server/webhooks/secret';

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

/** Rendered SQL of a recorded where-condition (lowercased for contains). */
function sqlOf(cond: unknown): string {
	return new PgDialect().sqlToQuery(cond as SQL).sql.toLowerCase();
}

function resetState() {
	state.selectQueue = [];
	state.insertValues = [];
	state.insertTables = [];
	state.insertRows = [{ id: 'new-delivery' }];
	state.insertError = null;
	state.updateSets = [];
	state.updateTables = [];
	state.updateRows = [{ id: 'updated-row' }];
	state.updateError = null;
	state.updateWheres = [];
	state.deleteTables = [];
	state.deleteRows = [{ id: 'deleted-row' }];
	state.deleteWheres = [];
	state.selectCount = 0;
	state.whereConds = [];
}

describe('notification webhooks retry', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetState();
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
		expect(state.selectCount).toBe(0);
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
		// The copy must target the deliveries table (round-2 SYT-1).
		expect(state.insertTables[0]).toBe(webhookDeliveriesMock);
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
		resetState();
	});

	it('every CRUD action runs requireAdminRole first', async () => {
		for (const name of ['create', 'update', 'delete', 'toggle', 'rotate']) {
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
		expect(state.selectCount).toBe(0);
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
		expect(state.selectCount).toBe(0);
		expect(state.insertValues).toHaveLength(0);
	});

	it('create is bounded by the length limits', async () => {
		const longName = await callAction('create', { ...validForm, name: 'x'.repeat(121) });
		expect(longName.result).toMatchObject({ status: 400, data: { op: 'create' } });
		const longUrl = await callAction('create', { ...validForm, payloadUrl: 'a'.repeat(2049) });
		expect(longUrl.result).toMatchObject({ status: 400 });
		expect(state.insertValues).toHaveLength(0);
	});

	it('create soft-rejects a duplicate name (case-insensitive, G3)', async () => {
		state.selectQueue.push([{ id: 'existing' }]);
		const { result } = await callAction('create', validForm);
		expect(result).toMatchObject({ status: 400, data: { op: 'create' } });
		expect(state.insertValues).toHaveLength(0);
		// The dup lookup is case-insensitive at the SQL layer: the name COLUMN
		// must sit inside lower(...) (round-2 SYT-3: a bare 'lower(' match also
		// passed a one-sided lower($1) regression).
		expect(sqlOf(state.whereConds[0])).toMatch(/lower\([^)]*name[^)]*\)/);
	});

	it('create inserts a generated whsec_ secret and reveals it exactly once', async () => {
		state.insertRows = [{ id: WEBHOOK_ID }];
		const { result } = await callAction('create', validForm);
		expect(result).toMatchObject({ op: 'create', created: true, id: WEBHOOK_ID });
		expect(state.insertTables[0]).toBe(webhooksMock);
		const inserted = state.insertValues[0] as Record<string, unknown>;
		expect(inserted.name).toBe('ops');
		expect(inserted.payloadUrl).toBe('https://example.com/hook');
		expect(inserted.events).toEqual(['job.run', 'schedule.toggle']);
		// 32 random bytes -> exactly 44 base64 chars incl. the padding `=`.
		expect(String(inserted.secret)).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
		expect(result?.secret).toBe(inserted.secret);
	});

	it('create stores the normalized href for odd-but-valid urls (review round-1)', async () => {
		state.insertRows = [{ id: WEBHOOK_ID }];
		await callAction('create', { ...validForm, payloadUrl: 'https:example.com' });
		await callAction('create', { ...validForm, payloadUrl: 'HTTPS://Example.com' });
		expect((state.insertValues[0] as { payloadUrl: string }).payloadUrl).toBe(
			'https://example.com/'
		);
		expect((state.insertValues[1] as { payloadUrl: string }).payloadUrl).toBe(
			'https://example.com/'
		);
	});

	it('create dedupes repeated event fields', async () => {
		state.insertRows = [{ id: WEBHOOK_ID }];
		await callAction('create', { ...validForm, events: ['job.run', 'job.run'] });
		expect((state.insertValues[0] as { events: string[] }).events).toEqual(['job.run']);
	});

	it('create accepts an empty event selection (mirrors the schema; never fires)', async () => {
		state.insertRows = [{ id: WEBHOOK_ID }];
		const { result } = await callAction('create', { ...validForm, events: [] });
		expect(result).toMatchObject({ op: 'create', created: true });
		expect((state.insertValues[0] as { events: string[] }).events).toEqual([]);
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
		// The self-exclusion rides on the recorded predicate: the name column
		// inside lower(...) AND <> (round-2 SYT-3).
		const dupSql = sqlOf(state.whereConds[0]);
		expect(dupSql).toMatch(/lower\([^)]*name[^)]*\)/);
		expect(dupSql).toContain('<>');

		state.selectQueue.push([]);
		state.updateRows = [];
		const gone = await callAction('update', { ...validForm, id: WEBHOOK_ID });
		expect(gone.result).toMatchObject({ status: 404, data: { op: 'update' } });
	});

	it('update writes ONLY the editable columns (secret/isEnabled untouched)', async () => {
		state.selectQueue.push([]);
		const { result } = await callAction('update', { ...validForm, id: WEBHOOK_ID });
		expect(result).toMatchObject({ op: 'update', updated: true });
		expect(state.updateTables[0]).toBe(webhooksMock);
		expect(state.updateSets[0]).toEqual({
			name: 'ops',
			payloadUrl: 'https://example.com/hook',
			events: ['job.run', 'schedule.toggle']
		});
		// The write predicate must target the row id (round-2 SYT-1: write
		// WHEREs are recorded so a dropped/mis-aimed predicate turns red).
		expect(sqlOf(state.updateWheres[0])).toContain('"webhooks"."id"');
	});

	it('update stores the normalized href like create (round-2 SYT-4)', async () => {
		state.selectQueue.push([]);
		await callAction('update', {
			...validForm,
			id: WEBHOOK_ID,
			payloadUrl: 'HTTPS://Example.com/Edit'
		});
		expect((state.updateSets[0] as { payloadUrl: string }).payloadUrl).toBe(
			'https://example.com/Edit'
		);
	});

	it('delete guards the id, 404s a vanished endpoint and succeeds otherwise', async () => {
		const badId = await callAction('delete', { id: 'nope' });
		expect(badId.result).toMatchObject({ status: 400, data: { op: 'delete' } });
		state.deleteRows = [];
		const gone = await callAction('delete', { id: WEBHOOK_ID });
		expect(gone.result).toMatchObject({ status: 404, data: { op: 'delete' } });
		state.deleteRows = [{ id: WEBHOOK_ID }];
		const ok = await callAction('delete', { id: WEBHOOK_ID });
		expect(ok.result).toMatchObject({ op: 'delete', deleted: true });
		expect(state.deleteTables[0]).toBe(webhooksMock);
		// The delete predicate must target the row id (round-2 SYT-1).
		expect(sqlOf(state.deleteWheres[0])).toContain('"webhooks"."id"');
	});

	it('toggle demands an explicit boolean and writes the desired state', async () => {
		const bad = await callAction('toggle', { id: WEBHOOK_ID, enabled: 'yes' });
		expect(bad.result).toMatchObject({ status: 400, data: { op: 'toggle' } });
		expect(state.updateSets).toHaveLength(0);

		const off = await callAction('toggle', { id: WEBHOOK_ID, enabled: 'false' });
		expect(off.result).toMatchObject({ op: 'toggle', toggled: true });
		expect(state.updateTables[0]).toBe(webhooksMock);
		expect(state.updateSets[0]).toEqual({ isEnabled: false });
		// The toggle predicate must target the row id (round-2 SYT-1).
		expect(sqlOf(state.updateWheres[0])).toContain('"webhooks"."id"');

		state.updateRows = [];
		const gone = await callAction('toggle', { id: WEBHOOK_ID, enabled: 'true' });
		expect(gone.result).toMatchObject({ status: 404, data: { op: 'toggle' } });
	});

	it('rotate guards the id, replaces the secret and reveals the new one once', async () => {
		const badId = await callAction('rotate', { id: '' });
		expect(badId.result).toMatchObject({ status: 400, data: { op: 'rotate' } });
		const { result } = await callAction('rotate', { id: WEBHOOK_ID });
		expect(result).toMatchObject({ op: 'rotate', rotated: true });
		expect(state.updateTables[0]).toBe(webhooksMock);
		const set = state.updateSets[0] as { secret: string };
		expect(set.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
		expect(result?.secret).toBe(set.secret);
		// The rotate predicate must target the row id (round-2 SYT-1).
		expect(sqlOf(state.updateWheres[0])).toContain('"webhooks"."id"');
		state.updateRows = [];
		const gone = await callAction('rotate', { id: WEBHOOK_ID });
		expect(gone.result).toMatchObject({ status: 404, data: { op: 'rotate' } });
	});

	it('maps a 23514 CHECK violation to a 400 instead of an unhandled 500 (round-2 N1)', async () => {
		state.insertError = Object.assign(new Error('check violation'), { code: '23514' });
		const created = await callAction('create', validForm);
		expect(created.result).toMatchObject({ status: 400, data: { op: 'create' } });
		state.insertError = null;
		state.updateError = Object.assign(new Error('check violation'), { code: '23514' });
		state.selectQueue.push([]);
		const updated = await callAction('update', { ...validForm, id: WEBHOOK_ID });
		expect(updated.result).toMatchObject({ status: 400, data: { op: 'update' } });
		state.updateError = null;
		// Anything else keeps propagating (fail loud).
		state.insertError = new Error('some other db error');
		const { thrown } = await callAction('create', validForm);
		expect(thrown).toBeTruthy();
	});

	it('load masks the secret and never ships the raw value', async () => {
		const raw = 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
		state.selectQueue.push([
			{
				id: WEBHOOK_ID,
				name: 'ops',
				payloadUrl: 'https://example.com/hook',
				events: ['job.run'],
				isEnabled: true,
				secret: raw
			}
		]);
		state.selectQueue.push([]);
		const data = (await load({} as never)) as {
			webhookEndpoints: Record<string, unknown>[];
		};
		const endpoint = data.webhookEndpoints[0];
		expect(endpoint).not.toHaveProperty('secret');
		expect(endpoint.secretPreview).toBe(maskWebhookSecret(raw));
		expect(String(endpoint.secretPreview)).toMatch(/^whsec_\u2026[^=]{4}$/);
	});
});
