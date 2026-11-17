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
		conflicts: [] as unknown[],
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
		requireAdminRole: vi.fn(async () => {}),
		recordActivity: vi.fn(async (...args: unknown[]) => {
			void args;
		}),
		sendMail: vi.fn(async (...args: unknown[]) => {
			void args;
		}),
		isMailConfigured: vi.fn(() => true)
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
				const rows = state.selectQueue.shift() ?? [];
				const pending = Promise.resolve(rows);
				return Object.assign(pending, {
					limit: async () => rows,
					orderBy: () => ({ limit: async () => rows })
				});
			},
			// The ids-only select (`select({ id }).from(webhooks)`) has no
			// orderBy/where and is awaited directly.
			then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
				const rows = state.selectQueue.shift() ?? [];
				return Promise.resolve(rows).then(resolve, reject);
			}
		})
	});
	const db = {
		// selectCount makes the "no db work before the guard" assertions real
		// (selectQueue-only assertions were tautological).
		select: () => {
			state.selectCount += 1;
			return makeSelect();
		},
		insert: (table: unknown) => {
			state.insertTables.push(table);
			return {
				values: (values: unknown) => {
					state.insertValues.push(values);
					const settle = async () => {
						if (state.insertError) throw state.insertError;
					};
					return {
						onConflictDoUpdate: async (config: unknown) => {
							await settle();
							state.conflicts.push(config);
						},
						returning: async () => {
							await settle();
							return state.insertRows;
						},
						// The route awaits `insert(...).values(...)` directly (no
						// `.returning()`), so the fake has to be thenable.
						then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
							settle().then(() => resolve(undefined), reject)
					};
				}
			};
		},
		// create/rotate write the endpoint and its encrypted secret in one
		// transaction; the fake runs the callback against the same recorder.
		transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
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
vi.mock('$lib/server/audit', () => ({ recordActivity: mocks.recordActivity }));
vi.mock('$lib/server/mail/transport', () => ({
	isMailConfigured: mocks.isMailConfigured,
	sendMail: mocks.sendMail
}));
// The secret is encrypted before it is stored, so the route needs a
// usable keyring. One fixed 32-byte test key, version 1.
vi.mock('$env/dynamic/private', () => ({
	env: {
		SECRETS_KEYS: `1:${Buffer.alloc(32, 7).toString('base64')}`,
		SECRETS_KEY_ACTIVE: '1'
	}
}));
vi.mock('$lib/server/config/options-registry', () => ({ getOption: vi.fn(async () => 'Etc/UTC') }));
// The URL guard resolves hostnames; tests pin a public address so the
// suite is deterministic and offline. Literal-IP cases never hit this mock.
vi.mock('node:dns/promises', () => ({
	lookup: vi.fn(async (hostname: string) =>
		hostname === 'rebind.example'
			? [{ address: '10.0.0.7', family: 4 }]
			: [{ address: '93.184.216.34', family: 4 }]
	)
}));

import { actions, load } from './+page.server';
import {
	webhookDeliveries as webhookDeliveriesMock,
	webhookSecrets as webhookSecretsMock,
	webhooks as webhooksMock
} from '$lib/server/db/system';
import { maskWebhookSecret } from '$lib/server/webhooks/secret';
import { decryptSecret, encryptSecret, secretAad } from '$lib/server/secrets/crypto';
import { parseKeyring } from '$lib/server/secrets/keyring';

const TEST_KEYRING = parseKeyring({
	keys: `1:${Buffer.alloc(32, 7).toString('base64')}`,
	active: '1'
});

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

function makeEvent(
	fields: Record<string, string | string[]>,
	role: 'owner' | 'admin' = 'owner',
	userOverrides: Record<string, unknown> = {}
) {
	return {
		request: new Request('http://x/admin/settings/notifications', {
			method: 'POST',
			body: makeFormData(fields)
		}),
		locals: {
			user: { id: 'admin-1', role, email: 'owner@example.com', ...userOverrides },
			admin: { userId: 'admin-1', role }
		}
	};
}

async function callAction(
	name: string,
	fields: Record<string, string | string[]>,
	role: 'owner' | 'admin' = 'owner',
	userOverrides: Record<string, unknown> = {}
) {
	try {
		const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[name];
		const result = (await fn(makeEvent(fields, role, userOverrides) as never)) as Record<
			string,
			unknown
		>;
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
	state.conflicts = [];
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

describe('notification mail test', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetState();
	});

	it('runs requireAdminRole first', async () => {
		guardMock.mockRejectedValueOnce(new Error('redirect: no session'));
		const { thrown } = await callAction('testMail', {});
		expect(thrown).toBeInstanceOf(Error);
		expect(state.selectCount).toBe(0);
	});

	it('refuses when SMTP is not configured (the button is disabled too)', async () => {
		mocks.isMailConfigured.mockReturnValueOnce(false);
		const { result } = await callAction('testMail', {});
		expect(result).toMatchObject({ status: 400 });
		expect(state.selectCount).toBe(0);
		expect(mocks.sendMail).not.toHaveBeenCalled();
	});

	it('refuses an account without an email address', async () => {
		const { result } = await callAction('testMail', {}, 'owner', { email: null });
		expect(result).toMatchObject({ status: 400 });
		expect(state.selectCount).toBe(0);
	});

	it('throttles a second send inside the minute window', async () => {
		state.selectQueue.push([{ createdAt: new Date(Date.now() - 5_000) }]);
		const { result } = await callAction('testMail', {});
		expect(result).toMatchObject({ status: 429 });
		expect(mocks.sendMail).not.toHaveBeenCalled();
		expect(mocks.recordActivity).not.toHaveBeenCalled();
		// The throttle reads this actor's own mail.test rows, not another admin's.
		const where = sqlOf(state.whereConds[0]);
		expect(where).toContain('"activities"."event"');
		expect(where).toContain('"activities"."actor_id"');
	});

	it('sends to the signed-in address and audits mail.test with a masked recipient', async () => {
		state.selectQueue.push([]);
		const { result } = await callAction('testMail', {});
		expect(result).toMatchObject({ op: 'testMail', mailTested: true });
		expect(mocks.sendMail).toHaveBeenCalledTimes(1);
		const mail = mocks.sendMail.mock.calls[0]![0] as { to: string; subject: string; text: string };
		expect(mail.to).toBe('owner@example.com');
		expect(mail.subject).toContain('SMTP test email');
		expect(mocks.recordActivity).toHaveBeenCalledTimes(1);
		expect(mocks.recordActivity.mock.calls[0]![1]).toMatchObject({
			event: 'mail.test',
			actorId: 'admin-1',
			payload: { to: 'o***@example.com', ok: true },
			deliver: false
		});
	});

	it('audits a failed send (the attempt still counts toward the limit)', async () => {
		state.selectQueue.push([]);
		mocks.sendMail.mockRejectedValueOnce(new Error('550 relay denied'));
		const { result } = await callAction('testMail', {});
		expect(result).toMatchObject({ status: 502 });
		expect(mocks.recordActivity.mock.calls[0]![1]).toMatchObject({
			event: 'mail.test',
			payload: { to: 'o***@example.com', ok: false, error: '550 relay denied' },
			deliver: false
		});
	});

	it('allows a non-owner admin to test mail (mail tier = admin)', async () => {
		state.selectQueue.push([]);
		const { result } = await callAction('testMail', {}, 'admin');
		expect(result).toMatchObject({ mailTested: true });
		expect(mocks.sendMail).toHaveBeenCalledTimes(1);
	});
});

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

	it('replays the same failed row - the delivery id (webhook-id) never changes', async () => {
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
		expect(ok.result).toMatchObject({ retried: true, id: 'updated-row' });
		// No copied row: the failed row itself is re-queued.
		expect(state.insertValues).toHaveLength(0);
		expect(state.updateTables[0]).toBe(webhookDeliveriesMock);
		const set = state.updateSets[0] as Record<string, unknown>;
		expect(set).toMatchObject({
			status: 'queued',
			attemptCount: 0,
			responseCode: null,
			error: null,
			deliveredAt: null
		});
		expect(set.nextAttemptAt).toBeInstanceOf(Date);
		expect(sqlOf(state.updateWheres[0])).toContain('"webhook_deliveries"."id"');
	});

	it('400s when the row vanishes or is no longer failed before the replay write', async () => {
		state.selectQueue.push([
			{ id: DELIVERY_ID, webhookId: 'w1', event: 'comment.created', payload: {}, status: 'failed' }
		]);
		state.selectQueue.push([{ isEnabled: true }]);
		state.updateRows = [];
		const { result } = await callRetry({ id: DELIVERY_ID });
		expect(result).toMatchObject({ status: 400 });
	});

	it('lets a non-owner admin replay (config is read-only, replay is not)', async () => {
		state.selectQueue.push([
			{ id: DELIVERY_ID, webhookId: 'w1', event: 'comment.created', payload: {}, status: 'failed' }
		]);
		state.selectQueue.push([{ isEnabled: true }]);
		const { result, thrown } = await callAction('retry', { id: DELIVERY_ID }, 'admin');
		expect(thrown).toBeUndefined();
		expect(result).toMatchObject({ retried: true });
	});

	it('load requires the admin role first (J-3 review I1)', async () => {
		guardMock.mockRejectedValueOnce(new Error('redirect: no session'));
		await expect(load({} as never)).rejects.toThrow('redirect: no session');
	});

	it('load renders webhook config read-only for a non-owner admin (mail stays editable)', async () => {
		state.selectQueue.push([]); // endpoints
		state.selectQueue.push([]); // deliveries
		const data = (await load({
			locals: { admin: { userId: 'admin-1', role: 'admin' } }
		} as never)) as { editable: boolean; mailEditable: boolean };
		expect(data.editable).toBe(false);
		expect(data.mailEditable).toBe(true);
	});

	it('replays without copying the failed row', async () => {
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
		expect(ok.result).toMatchObject({ retried: true });
		expect(state.insertValues).toHaveLength(0);
		expect(state.updateSets[0]).toMatchObject({ status: 'queued', attemptCount: 0 });
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

	it('re-checks the owner-only webhook tier for a non-owner admin', async () => {
		for (const name of ['create', 'update', 'delete', 'toggle', 'rotate']) {
			const { thrown } = await callAction(
				name,
				{
					id: WEBHOOK_ID,
					name: 'ops',
					payloadUrl: 'https://example.com/hook',
					enabled: 'true',
					events: 'job.run'
				},
				'admin'
			);
			expect((thrown as { status?: number } | undefined)?.status).toBe(403);
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

	it('create refuses http, credentials and private/metadata targets', async () => {
		const cases = [
			'http://example.com/hook',
			'https://user:pass@example.com/hook',
			'https://127.0.0.1/hook',
			'https://169.254.169.254/latest/meta-data',
			'https://10.0.0.5/hook',
			'https://[::1]/hook',
			'https://rebind.example/hook'
		];
		for (const payloadUrl of cases) {
			const { result } = await callAction('create', { ...validForm, payloadUrl });
			expect(result, payloadUrl).toMatchObject({ status: 400, data: { op: 'create' } });
		}
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

	it('create stores the endpoint and an encrypted secret, revealing the raw value once', async () => {
		const { result } = await callAction('create', validForm);
		expect(result).toMatchObject({ op: 'create', created: true });
		expect(state.insertTables[0]).toBe(webhooksMock);
		expect(state.insertTables[1]).toBe(webhookSecretsMock);
		const endpointRow = state.insertValues[0] as Record<string, unknown>;
		expect(endpointRow.name).toBe('ops');
		expect(endpointRow.payloadUrl).toBe('https://example.com/hook');
		expect(endpointRow.events).toEqual(['job.run', 'schedule.toggle']);
		// The plaintext column is not written by the new path.
		expect(endpointRow).not.toHaveProperty('secret');
		const secretRow = state.insertValues[1] as Record<string, unknown>;
		// 32 random bytes -> exactly 44 base64 chars incl. the padding `=`.
		expect(String(result?.secret)).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
		expect(String(secretRow.ciphertext)).toMatch(/^v1:1:/);
		expect(secretRow.keyVersion).toBe(1);
		expect(String(secretRow.hint)).toMatch(/^whsec_\u2026/);
		// The raw value never reaches a stored row.
		expect(JSON.stringify(state.insertValues)).not.toContain(String(result?.secret));
		// Audit is local (deliver:false) and carries only the hint.
		const recordCalls = (mocks.recordActivity as unknown as { mock: { calls: unknown[][] } }).mock
			.calls;
		const auditCall = recordCalls.find(
			(call) => (call[1] as { event?: string }).event === 'webhook.key_set'
		);
		expect(auditCall).toBeDefined();
		const audit = auditCall?.[1] as { deliver?: boolean; payload?: Record<string, unknown> };
		expect(audit.deliver).toBe(false);
		expect(audit.payload?.hint).toBe(secretRow.hint);
		expect(JSON.stringify(audit)).not.toContain(String(result?.secret));
		// Config audit: host + subscription, local only, never the secret.
		const createAudit = recordCalls.find(
			(call) => (call[1] as { event?: string }).event === 'webhook.create'
		);
		expect(createAudit).toBeDefined();
		const config = createAudit?.[1] as { deliver?: boolean; payload?: Record<string, unknown> };
		expect(config.deliver).toBe(false);
		expect(config.payload).toMatchObject({
			name: 'ops',
			host: 'example.com',
			events: ['job.run', 'schedule.toggle']
		});
		expect(JSON.stringify(config)).not.toContain(String(result?.secret));
	});

	it('create stores the normalized href for odd-but-valid urls', async () => {
		await callAction('create', { ...validForm, payloadUrl: 'https:example.com' });
		await callAction('create', { ...validForm, payloadUrl: 'HTTPS://Example.com' });
		// Each create writes two rows (endpoint + encrypted secret).
		expect((state.insertValues[0] as { payloadUrl: string }).payloadUrl).toBe(
			'https://example.com/'
		);
		expect((state.insertValues[2] as { payloadUrl: string }).payloadUrl).toBe(
			'https://example.com/'
		);
	});

	it('create dedupes repeated event fields', async () => {
		state.insertRows = [{ id: WEBHOOK_ID }];
		await callAction('create', { ...validForm, events: ['job.run', 'job.run'] });
		expect((state.insertValues[0] as { events: string[] }).events).toEqual(['job.run']);
	});

	it('create refuses an empty event selection (nine-dimension DB-01: silent black hole)', async () => {
		const { result } = await callAction('create', { ...validForm, events: [] });
		expect(result).toMatchObject({ status: 400, data: { op: 'create' } });
		expect(state.insertValues).toHaveLength(0);
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
		const updateAudit = vi
			.mocked(mocks.recordActivity)
			.mock.calls.find((call) => (call[1] as { event?: string }).event === 'webhook.update');
		expect(updateAudit).toBeDefined();
		const updatePayload = (updateAudit?.[1] as { payload?: Record<string, unknown> }).payload;
		expect(updatePayload).toMatchObject({ webhookId: WEBHOOK_ID, host: 'example.com' });
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
		// The delete predicate must target the row id.
		expect(sqlOf(state.deleteWheres[0])).toContain('"webhooks"."id"');
		// Deleting an endpoint is a config change and leaves an audit row.
		const deleteAudit = vi
			.mocked(mocks.recordActivity)
			.mock.calls.find((call) => (call[1] as { event?: string }).event === 'webhook.delete');
		expect(deleteAudit).toBeDefined();
		expect((deleteAudit?.[1] as { payload?: Record<string, unknown> }).payload).toMatchObject({
			webhookId: WEBHOOK_ID
		});
	});

	it('toggle demands an explicit boolean and writes the desired state', async () => {
		const badId = await callAction('toggle', { id: 'nope', enabled: 'true' });
		expect(badId.result).toMatchObject({ status: 400, data: { op: 'toggle' } });
		expect(state.updateSets).toHaveLength(0);
		const bad = await callAction('toggle', { id: WEBHOOK_ID, enabled: 'yes' });
		expect(bad.result).toMatchObject({ status: 400, data: { op: 'toggle' } });
		expect(state.updateSets).toHaveLength(0);

		const off = await callAction('toggle', { id: WEBHOOK_ID, enabled: 'false' });
		expect(off.result).toMatchObject({ op: 'toggle', toggled: true });
		expect(state.updateTables[0]).toBe(webhooksMock);
		expect(state.updateSets[0]).toEqual({ isEnabled: false });
		// The toggle predicate must target the row id (round-2 SYT-1).
		expect(sqlOf(state.updateWheres[0])).toContain('"webhooks"."id"');
		const toggleAudit = vi
			.mocked(mocks.recordActivity)
			.mock.calls.find((call) => (call[1] as { event?: string }).event === 'webhook.toggle');
		expect((toggleAudit?.[1] as { payload?: Record<string, unknown> }).payload).toMatchObject({
			webhookId: WEBHOOK_ID,
			enabled: false
		});

		state.updateRows = [];
		const gone = await callAction('toggle', { id: WEBHOOK_ID, enabled: 'true' });
		expect(gone.result).toMatchObject({ status: 404, data: { op: 'toggle' } });
	});

	it('rotate keeps the old value in the grace slot and reveals the new one once', async () => {
		const badId = await callAction('rotate', { id: '' });
		expect(badId.result).toMatchObject({ status: 400, data: { op: 'rotate' } });

		// Existing encrypted row: it is decrypted and re-encrypted into the
		// `previous_ciphertext` AAD slot (copying the envelope would fail every
		// delivery for the whole grace window).
		const oldCiphertext = encryptSecret(
			'whsec_old_value',
			Buffer.alloc(32, 7),
			1,
			secretAad('webhook_secrets', WEBHOOK_ID, 'ciphertext')
		);
		state.selectQueue.push([{ id: WEBHOOK_ID, name: 'ops', legacySecret: null }]);
		state.selectQueue.push([{ ciphertext: oldCiphertext, keyVersion: 1 }]);
		const { result } = await callAction('rotate', { id: WEBHOOK_ID });
		expect(result).toMatchObject({ op: 'rotate', rotated: true });
		expect(String(result?.secret)).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
		expect(state.insertTables[0]).toBe(webhookSecretsMock);
		const row = state.insertValues[0] as Record<string, unknown>;
		expect(String(row.ciphertext)).toMatch(/^v1:1:/);
		expect(row.previousKeyVersion).toBe(1);
		expect(row.previousExpiresAt).toBeInstanceOf(Date);
		expect((row.previousExpiresAt as Date).getTime()).toBeGreaterThan(Date.now());
		// The grace value is readable through the previous-slot AAD.
		expect(
			decryptSecret(
				String(row.previousCiphertext),
				TEST_KEYRING.resolve,
				secretAad('webhook_secrets', WEBHOOK_ID, 'previous_ciphertext')
			).plaintext
		).toBe('whsec_old_value');
		expect(state.conflicts).toHaveLength(1);
		// The rotation is audited, never fanned out, and the payload carries
		// metadata only (no value, no ciphertext).
		const rotateAudit = (
			mocks.recordActivity as unknown as { mock: { calls: unknown[][] } }
		).mock.calls.find((call) => (call[1] as { event?: string })?.event === 'webhook.key_rotate');
		expect(rotateAudit).toBeTruthy();
		expect(rotateAudit?.[1]).toMatchObject({ deliver: false });
		const auditJson = JSON.stringify(rotateAudit?.[1]);
		// The mask prefix is expected; the value itself and the envelope are not.
		expect(auditJson).not.toContain('whsec_old_value');
		expect(auditJson).not.toContain('v1:');
		// The plaintext column is not touched when there is nothing to retire.
		expect(state.updateTables).toHaveLength(0);

		state.selectQueue.push([]);
		const gone = await callAction('rotate', { id: WEBHOOK_ID });
		expect(gone.result).toMatchObject({ status: 404, data: { op: 'rotate' } });

		// An unreadable current envelope must abort the rotation: writing a
		// previous slot we cannot re-encrypt would lose the only verifiable
		// value.
		state.selectQueue.push([{ id: WEBHOOK_ID, name: 'ops', legacySecret: 'whsec_legacy' }]);
		state.selectQueue.push([{ ciphertext: 'v1:1:AA:BB:CC', keyVersion: 1 }]);
		const broken = await callAction('rotate', { id: WEBHOOK_ID });
		expect(broken.result).toMatchObject({ status: 503, data: { op: 'rotate' } });
		expect(state.updateTables).toHaveLength(0);
	});

	it('refuses credentialed payload urls (nine-dimension SY-L2-01)', async () => {
		const { result } = await callAction('create', {
			...validForm,
			payloadUrl: 'https://admin:hunter2@hooks.example.com/path'
		});
		expect(result).toMatchObject({ status: 400, data: { op: 'create' } });
		expect(state.insertValues).toHaveLength(0);
	});

	it('accepts exactly-at-the-boundary name and url (nine-dimension SYF-1)', async () => {
		state.insertRows = [{ id: WEBHOOK_ID }];
		const longUrl = 'https://example.com/' + 'a'.repeat(2048 - 'https://example.com/'.length);
		expect(longUrl).toHaveLength(2048);
		const atName = await callAction('create', {
			...validForm,
			name: 'x'.repeat(120),
			payloadUrl: longUrl
		});
		expect(atName.result).toMatchObject({ op: 'create', created: true });
		expect((state.insertValues[0] as { name: string }).name).toBe('x'.repeat(120));
		expect((state.insertValues[0] as { payloadUrl: string }).payloadUrl).toBe(longUrl);
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
		const data = (await load({ locals: { admin: { role: 'owner' } } } as never)) as {
			webhookEndpoints: Record<string, unknown>[];
		};
		const endpoint = data.webhookEndpoints[0];
		expect(endpoint).not.toHaveProperty('secret');
		expect(endpoint.secretPreview).toBe(maskWebhookSecret(raw));
		expect(String(endpoint.secretPreview)).toMatch(/^whsec_\u2026[^=]{4}$/);
	});
});
