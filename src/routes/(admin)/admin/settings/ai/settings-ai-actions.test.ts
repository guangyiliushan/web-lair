import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiProviders } from '$lib/server/db/ai';
import { options } from '$lib/server/db/config';

/**
 * Route-level tests for the AI settings actions (AI-2, repaired in AI-2.1):
 * validation, the duplicate-name translation built with PRODUCTION error
 * shape (drizzle wraps driver errors - the 23505 code lives on the cause),
 * uuid entry guards, the transactional assignment cascades on provider
 * delete/rename and the options-registry writes behind moderation/budget/
 * style-guide. The db module is mocked; zod and the registry stay real.
 */
const ROW_ID = '11111111-1111-1111-1111-111111111111';

const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selects: [] as unknown[][],
		inserts: [] as { table: unknown; values: Record<string, unknown>; conflict?: unknown }[],
		updates: [] as { table: unknown; values: Record<string, unknown> }[],
		deletes: [] as { table: unknown }[],
		deletedRows: [{ name: 'E2E Provider' }] as unknown[],
		insertError: null as unknown
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));
vi.mock('$env/dynamic/private', () => ({ env: { AI_E2E_TEST_KEY: 'sk-test' } }));

import { requireAdminRole } from '$lib/server/authz';
import { actions } from './+page.server';

const guardMock = vi.mocked(requireAdminRole);

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				return () => self;
			}
		}
	);
	return self;
}

function makeInsertBuilder(table: unknown) {
	return {
		values: (values: Record<string, unknown>) => {
			const record = { table, values } as (typeof state.inserts)[number];
			const settle = async () => {
				if (state.insertError) throw state.insertError;
				state.inserts.push(record);
			};
			return {
				onConflictDoUpdate: async (conflict: unknown) => {
					record.conflict = conflict;
					await settle();
				},
				then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
					settle().then(resolve, reject)
			};
		}
	};
}

/**
 * The db client and the transaction executor share this builder set, so a
 * transaction callback sees the same queues and assertions hold either way.
 */
function makeExecutors() {
	return {
		select: vi.fn(() => makeChain(state.selects.shift() ?? [])),
		insert: vi.fn((table: unknown) => makeInsertBuilder(table)),
		update: vi.fn((table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: async () => {
					state.updates.push({ table, values });
				}
			})
		})),
		delete: vi.fn((table: unknown) => ({
			where: () => ({
				returning: async () => {
					state.deletes.push({ table });
					return state.deletedRows;
				}
			})
		}))
	};
}

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return { request: new Request('http://x/admin/settings/ai', { method: 'POST', body }) };
}

async function callAction(name: string, fields: Record<string, string>) {
	try {
		const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[name];
		const result = await fn(makeEvent(fields) as never);
		return { result, thrown: undefined };
	} catch (thrown) {
		return { result: undefined, thrown };
	}
}

describe('AI settings actions', () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		state.selects = [];
		state.inserts = [];
		state.updates = [];
		state.deletes = [];
		state.deletedRows = [{ name: 'E2E Provider' }];
		state.insertError = null;

		const executors = makeExecutors();
		Object.assign(dbMock, {
			...executors,
			transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(executors))
		});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		vi.unstubAllGlobals();
	});

	it('runs every action behind the admin guard first', async () => {
		guardMock.mockClear();
		state.selects = [[]];
		for (const name of [
			'saveProvider',
			'deleteProvider',
			'testProvider',
			'saveAssignments',
			'saveModeration',
			'saveBudget',
			'saveStyleGuide'
		]) {
			await callAction(name, {});
		}
		expect(guardMock).toHaveBeenCalledTimes(7);
	});

	it('rejects an invalid provider form before touching the database', async () => {
		const { result } = await callAction('saveProvider', { name: '', kind: 'openai-compatible' });
		expect(result).toMatchObject({ status: 400 });
		expect(
			(result as { data?: { providerErrors?: Record<string, string> } }).data?.providerErrors?.name
		).toBeTruthy();
		expect(state.inserts).toHaveLength(0);
	});

	it('rejects malformed provider ids before they reach the database', async () => {
		const save = await callAction('saveProvider', {
			id: 'not-a-uuid',
			name: 'E2E Provider',
			kind: 'custom',
			baseUrl: 'https://gw.test'
		});
		expect(save.result).toMatchObject({ status: 400, data: { message: '服务商标识无效' } });
		const del = await callAction('deleteProvider', { id: 'not-a-uuid' });
		expect(del.result).toMatchObject({ status: 400, data: { message: '服务商标识无效' } });
		const test = await callAction('testProvider', { id: 'not-a-uuid' });
		expect(test.result).toMatchObject({ status: 400, data: { message: '服务商标识无效' } });
		expect(state.updates).toHaveLength(0);
		expect(state.inserts).toHaveLength(0);
		expect(state.deletes).toHaveLength(0);
	});

	it('creates a provider with the parsed payload', async () => {
		const { result } = await callAction('saveProvider', {
			name: 'E2E Provider',
			kind: 'openai-compatible',
			baseUrl: '',
			apiKeyEnv: 'AI_OPENAI_KEY',
			models: 'gpt-a\n gpt-b ',
			enabled: 'on'
		});
		expect(result).toMatchObject({ message: '服务商已创建' });
		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0].table).toBe(aiProviders);
		expect(state.inserts[0].values).toEqual({
			name: 'E2E Provider',
			kind: 'openai-compatible',
			baseUrl: null,
			apiKeyEnv: 'AI_OPENAI_KEY',
			models: ['gpt-a', 'gpt-b'],
			enabled: true
		});
	});

	it('translates a duplicate name into a field error (cause-shaped 23505)', async () => {
		// Production shape: drizzle's DrizzleQueryError carries the PG code on
		// `cause`, not on the top-level error object (AI-2.1 review).
		state.insertError = Object.assign(new Error('dup'), { cause: { code: '23505' } });
		const { result } = await callAction('saveProvider', {
			name: 'E2E Provider',
			kind: 'custom',
			baseUrl: 'https://gw.test',
			apiKeyEnv: '',
			models: '',
			enabled: 'on'
		});
		expect(result).toMatchObject({ status: 400, data: { message: '名称已存在' } });
	});

	it('updates a provider by id', async () => {
		state.selects = [[{ name: 'E2E Provider' }]];
		const { result } = await callAction('saveProvider', {
			id: ROW_ID,
			name: 'E2E Provider',
			kind: 'custom',
			baseUrl: 'https://gw.test',
			apiKeyEnv: '',
			models: ''
		});
		expect(result).toMatchObject({ message: '服务商已更新' });
		expect(state.updates[0].values).toMatchObject({ enabled: false, baseUrl: 'https://gw.test' });
	});

	it('renames a provider and remaps its assignment entries', async () => {
		state.selects = [
			[{ name: 'Old Name' }],
			[{ value: { summary: { provider: 'Old Name' }, chat: { provider: 'K' } } }]
		];
		const { result } = await callAction('saveProvider', {
			id: ROW_ID,
			name: 'New Name',
			kind: 'custom',
			baseUrl: 'https://gw.test',
			apiKeyEnv: '',
			models: ''
		});
		expect(result).toMatchObject({ message: '服务商已更新（并同步 1 个功能位分配）' });
		const optionsWrite = state.inserts.find((i) => i.table === options);
		expect(optionsWrite?.values).toEqual({
			name: 'ai.assignments',
			value: { summary: { provider: 'New Name' }, chat: { provider: 'K' } }
		});
	});

	it('deleting a provider also drops its assignment entries', async () => {
		// getOption('ai.assignments') reads the options row (inside the tx).
		state.selects = [
			[{ value: { summary: { provider: 'E2E Provider' }, chat: { provider: 'K' } } }]
		];
		const { result } = await callAction('deleteProvider', { id: ROW_ID });
		expect(result).toMatchObject({ message: '已删除 E2E Provider（并移除 1 个功能位分配）' });
		const optionsWrite = state.inserts.find((i) => i.table === options);
		expect(optionsWrite?.values).toEqual({
			name: 'ai.assignments',
			value: { chat: { provider: 'K' } }
		});
	});

	it('testProvider reports the connection result for the stored row', async () => {
		state.selects = [
			[
				{
					id: ROW_ID,
					name: 'E2E Provider',
					kind: 'openai-compatible',
					baseUrl: null,
					apiKeyEnv: 'AI_E2E_TEST_KEY'
				}
			]
		];
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 200 }))
		);
		const { result } = await callAction('testProvider', { id: ROW_ID });
		expect(result).toMatchObject({
			providerTest: { id: ROW_ID, name: 'E2E Provider', ok: true }
		});
	});

	it('saves assignments for the provided functions only', async () => {
		state.selects = [[{ name: 'E2E Provider' }]];
		const { result } = await callAction('saveAssignments', {
			assign_summary: 'E2E Provider',
			model_summary: 'gpt-a',
			assign_chat: '',
			model_chat: 'ignored'
		});
		expect(result).toMatchObject({ message: '功能位分配已保存' });
		const optionsWrite = state.inserts.find((i) => i.table === options);
		expect(optionsWrite?.values).toEqual({
			name: 'ai.assignments',
			value: { summary: { provider: 'E2E Provider', model: 'gpt-a' } }
		});
	});

	it('rejects unknown providers in assignments', async () => {
		state.selects = [[{ name: 'E2E Provider' }]];
		const { result } = await callAction('saveAssignments', { assign_summary: 'ghost' });
		expect(result).toMatchObject({ status: 400 });
	});

	it('rejects a broken regex and accepts a valid moderation payload', async () => {
		const broken = await callAction('saveModeration', {
			enabled: 'on',
			shadowMode: 'on',
			linkThreshold: '2',
			firstCommentHold: 'on',
			allow: '0.9',
			block: '0.95',
			keywords: 'spam',
			regexes: '([unclosed',
			trustedUsers: ''
		});
		expect(broken.result).toMatchObject({ status: 400 });
		expect(state.inserts).toHaveLength(0);

		const ok = await callAction('saveModeration', {
			enabled: 'on',
			shadowMode: 'on',
			linkThreshold: '3',
			firstCommentHold: 'on',
			allow: '0.9',
			block: '0.95',
			keywords: 'spam\nscam',
			regexes: 'https?://',
			trustedUsers: 'user-1'
		});
		expect(ok.result).toMatchObject({ message: '审核设置已保存' });
		const optionsWrite = state.inserts.find((i) => i.table === options);
		expect(optionsWrite?.values).toEqual({
			name: 'comments.moderation',
			value: {
				enabled: true,
				shadowMode: true,
				keywords: ['spam', 'scam'],
				regexes: ['https?://'],
				linkThreshold: 3,
				firstCommentHold: true,
				trustedUsers: ['user-1'],
				thresholds: { allow: 0.9, block: 0.95 }
			}
		});
	});

	it('requires explicit moderation numbers and ordered thresholds', async () => {
		const missing = await callAction('saveModeration', { allow: '0.9', block: '0.95' });
		expect(missing.result).toMatchObject({
			status: 400,
			data: { message: '链接数阈值不能为空' }
		});

		const inverted = await callAction('saveModeration', {
			linkThreshold: '2',
			allow: '0.99',
			block: '0.5',
			keywords: '',
			regexes: '',
			trustedUsers: ''
		});
		expect(inverted.result).toMatchObject({
			status: 400,
			data: { message: expect.stringContaining('放行阈值') }
		});
		expect(state.inserts).toHaveLength(0);
	});

	it('validates the budget before writing', async () => {
		const bad = await callAction('saveBudget', { monthly: '-1' });
		expect(bad.result).toMatchObject({ status: 400 });
		const ok = await callAction('saveBudget', {
			monthly: '20',
			currency: 'EUR',
			alertRatios: '0.8, 0.9, 1',
			pauseAutoOnExceed: 'on'
		});
		expect(ok.result).toMatchObject({ message: '预算设置已保存' });
		const optionsWrite = state.inserts.find((i) => i.table === options);
		expect(optionsWrite?.values).toEqual({
			name: 'ai.budget',
			value: { monthly: 20, currency: 'EUR', alertRatios: [0.8, 0.9, 1], pauseAutoOnExceed: true }
		});
	});

	it('treats empty alert ratios as the defaults and garbage as an error', async () => {
		const empty = await callAction('saveBudget', {
			monthly: '0',
			currency: 'USD',
			alertRatios: '',
			pauseAutoOnExceed: 'on'
		});
		expect(empty.result).toMatchObject({ message: '预算设置已保存' });
		const optionsWrite = state.inserts.find((i) => i.table === options);
		expect(optionsWrite?.values).toEqual({
			name: 'ai.budget',
			value: { monthly: 0, currency: 'USD', alertRatios: [0.8, 0.9, 1], pauseAutoOnExceed: true }
		});

		state.inserts = [];
		const bad = await callAction('saveBudget', { monthly: '0', alertRatios: 'abc, 1' });
		expect(bad.result).toMatchObject({
			status: 400,
			data: { message: '告警比例应为小数（如 0.8, 0.9, 1）' }
		});
		expect(state.inserts).toHaveLength(0);
	});

	it('saves the style guide through the registry', async () => {
		const { result } = await callAction('saveStyleGuide', { text: 'dry tone' });
		expect(result).toMatchObject({ message: '风格指南已保存' });
		const optionsWrite = state.inserts.find((i) => i.table === options);
		expect(optionsWrite?.values).toEqual({ name: 'ai.styleGuide', value: { text: 'dry tone' } });
	});
});
