import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the /admin/maintenance actions (J-3): guard-first for
 * every action, uuid guards before the service layer, service results mapped
 * to the right status codes, and the manual-run path handing the resolved
 * definition to enqueueJob (the queue requires one for non-registry names -
 * J-2 review D2 note). The jobs services are mocked wholesale; the ledger
 * queries inside `load` are exercised by e2e and the verify harness.
 */

const { mocks, state } = vi.hoisted(() => {
	const state = {
		enqueueCalls: [] as unknown[][],
		auditCalls: [] as Record<string, unknown>[],
		createCalls: [] as Record<string, unknown>[],
		updateCalls: [] as Record<string, unknown>[],
		toggleCalls: [] as Record<string, unknown>[],
		deleteCalls: [] as Record<string, unknown>[],
		resolveResult: null as Record<string, unknown> | null,
		createResult: { kind: 'created', id: 'sched-1' } as Record<string, unknown>,
		updateResult: { kind: 'updated', id: 'sched-1', watermarkReset: true } as Record<
			string,
			unknown
		>,
		toggleResult: { kind: 'toggled', id: 'sched-1', enabled: true } as Record<string, unknown>,
		deleteResult: { kind: 'deleted', id: 'sched-1' } as Record<string, unknown>
	};
	const mocks = {
		requireAdminRole: vi.fn(async () => {}),
		getOption: vi.fn(async () => 'Etc/UTC'),
		resolveDataDir: vi.fn(() => '/data'),
		enqueueJob: vi.fn(async (...args: unknown[]) => {
			state.enqueueCalls.push(args);
			return { id: 'run-1', deduplicated: false };
		}),
		recordActivity: vi.fn(async (_executor: unknown, input: Record<string, unknown>) => {
			state.auditCalls.push(input);
		}),
		resolveJobDefinition: vi.fn(async () => state.resolveResult),
		listScripts: vi.fn(async () => []),
		listSchedules: vi.fn(async () => []),
		createSchedule: vi.fn(async (input: Record<string, unknown>) => {
			state.createCalls.push(input);
			return state.createResult;
		}),
		updateSchedule: vi.fn(async (input: Record<string, unknown>) => {
			state.updateCalls.push(input);
			return state.updateResult;
		}),
		toggleSchedule: vi.fn(async (input: Record<string, unknown>) => {
			state.toggleCalls.push(input);
			return state.toggleResult;
		}),
		deleteSchedule: vi.fn(async (input: Record<string, unknown>) => {
			state.deleteCalls.push(input);
			return state.deleteResult;
		})
	};
	return { mocks, state };
});

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/db/system', () => ({ jobRuns: {}, activities: {} }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: mocks.requireAdminRole }));
vi.mock('$lib/server/audit', () => ({ recordActivity: mocks.recordActivity }));
vi.mock('$lib/server/config/options-registry', () => ({ getOption: mocks.getOption }));
vi.mock('$lib/server/jobs/data-dir', () => ({ resolveDataDir: mocks.resolveDataDir }));
vi.mock('$lib/server/jobs/job-scripts', () => ({ listScripts: mocks.listScripts }));
vi.mock('$lib/server/jobs/job-schedules', () => ({
	createSchedule: mocks.createSchedule,
	updateSchedule: mocks.updateSchedule,
	toggleSchedule: mocks.toggleSchedule,
	deleteSchedule: mocks.deleteSchedule,
	listSchedules: mocks.listSchedules,
	validateScheduleInput: vi.fn()
}));
vi.mock('$lib/server/jobs/queue', () => ({ enqueueJob: mocks.enqueueJob }));
vi.mock('$lib/server/jobs/user-layer', () => ({
	resolveJobDefinition: mocks.resolveJobDefinition
}));

import { actions } from './+page.server';

const guardMock = vi.mocked(mocks.requireAdminRole);
const SCHED_ID = '22222222-2222-7222-8222-222222222222';
const ACTION_NAMES = [
	'run',
	'typecheck',
	'scheduleCreate',
	'scheduleUpdate',
	'scheduleToggle',
	'scheduleDelete'
];

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://x/admin/maintenance', { method: 'POST', body }),
		locals: { user: { id: 'admin-1' } }
	};
}

async function callAction(name: string, fields: Record<string, string> = {}) {
	try {
		const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[name];
		const result = (await fn(makeEvent(fields) as never)) as Record<string, unknown>;
		return { result, thrown: undefined as unknown };
	} catch (thrown) {
		return { result: undefined, thrown };
	}
}

function callsWereMade(): boolean {
	return (
		state.enqueueCalls.length > 0 ||
		state.createCalls.length > 0 ||
		state.updateCalls.length > 0 ||
		state.toggleCalls.length > 0 ||
		state.deleteCalls.length > 0
	);
}

describe('admin maintenance actions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.enqueueCalls = [];
		state.auditCalls = [];
		state.createCalls = [];
		state.updateCalls = [];
		state.toggleCalls = [];
		state.deleteCalls = [];
		state.resolveResult = null;
		state.createResult = { kind: 'created', id: 'sched-1' };
		state.updateResult = { kind: 'updated', id: 'sched-1', watermarkReset: true };
		state.toggleResult = { kind: 'toggled', id: 'sched-1', enabled: true };
		state.deleteResult = { kind: 'deleted', id: 'sched-1' };
		mocks.getOption.mockResolvedValue('Etc/UTC');
	});

	it('runs requireAdminRole before anything else (all six actions)', async () => {
		for (const name of ACTION_NAMES) {
			guardMock.mockRejectedValueOnce(new Error('redirect: no session'));
			const { thrown } = await callAction(name, { name: 'x', id: SCHED_ID });
			expect(thrown).toBeInstanceOf(Error);
		}
		expect(callsWereMade()).toBe(false);
	});

	it('run: enqueues with the resolved definition and audits job.run', async () => {
		state.resolveResult = { name: 'my-task', manual: true };
		const { result } = await callAction('run', { name: 'my-task' });
		expect(result).toMatchObject({ queued: true, name: 'my-task', deduplicated: false });
		expect(state.enqueueCalls[0][1]).toBe('my-task');
		expect(state.enqueueCalls[0][2]).toBe('manual');
		expect(state.enqueueCalls[0][3]).toEqual({ name: 'my-task', manual: true });
		expect(state.auditCalls[0]).toMatchObject({
			event: 'job.run',
			actorId: 'admin-1',
			payload: { name: 'my-task', trigger: 'manual', deduplicated: false }
		});
	});

	it('run: 404 for unknown jobs, 400 for non-manual ones, missing name fails fast', async () => {
		state.resolveResult = null;
		const unknown = await callAction('run', { name: 'ghost' });
		expect(unknown.result).toMatchObject({ status: 404 });

		state.resolveResult = { name: 'auto-only', manual: false };
		const nonManual = await callAction('run', { name: 'auto-only' });
		expect(nonManual.result).toMatchObject({ status: 400 });

		state.resolveResult = { name: 'whatever', manual: true };
		const missing = await callAction('run', {});
		expect(missing.result).toMatchObject({ status: 400 });
		expect(state.enqueueCalls).toHaveLength(0);
	});

	it('typecheck: enqueues jobs.typecheck without a definition', async () => {
		const { result } = await callAction('typecheck');
		expect(result).toMatchObject({ queued: true, name: 'jobs.typecheck' });
		expect(state.enqueueCalls[0][1]).toBe('jobs.typecheck');
		expect(state.enqueueCalls[0][2]).toBe('manual');
		expect(state.enqueueCalls[0][3]).toBeUndefined();
		expect(state.auditCalls[0]).toMatchObject({ event: 'job.run' });
	});

	it('scheduleCreate: falls back to site.timezone and maps every result kind', async () => {
		const { result } = await callAction('scheduleCreate', {
			job: 'jobs.prune',
			cron_expr: '0 4 * * *',
			tz: ''
		});
		expect(result).toMatchObject({ scheduleChanged: true });
		expect(state.createCalls[0]).toMatchObject({
			job: 'jobs.prune',
			cronExpr: '0 4 * * *',
			tz: 'Etc/UTC',
			actorId: 'admin-1'
		});

		state.createResult = { kind: 'invalid', message: 'bad cron' };
		expect(
			(await callAction('scheduleCreate', { job: 'x', cron_expr: 'bad' })).result
		).toMatchObject({
			status: 400
		});
		state.createResult = { kind: 'unknown-job', message: '未知的 job' };
		expect(
			(await callAction('scheduleCreate', { job: 'x', cron_expr: '0 4 * * *' })).result
		).toMatchObject({
			status: 404
		});
		state.createResult = { kind: 'duplicate' };
		expect(
			(await callAction('scheduleCreate', { job: 'x', cron_expr: '0 4 * * *' })).result
		).toMatchObject({
			status: 409
		});
		expect((await callAction('scheduleCreate', {})).result).toMatchObject({ status: 400 });
	});

	it('scheduleToggle: uuid guard first, then not-found / toggled', async () => {
		const bad = await callAction('scheduleToggle', { id: 'not-a-uuid' });
		expect(bad.result).toMatchObject({ status: 400 });
		expect(state.toggleCalls).toHaveLength(0);

		state.toggleResult = { kind: 'not-found' };
		expect((await callAction('scheduleToggle', { id: SCHED_ID })).result).toMatchObject({
			status: 404
		});

		state.toggleResult = { kind: 'toggled', id: SCHED_ID, enabled: true };
		const ok = await callAction('scheduleToggle', { id: SCHED_ID });
		expect(ok.result).toMatchObject({ scheduleChanged: true, enabled: true });
	});

	it('scheduleUpdate: uuid guard first, watermark result passthrough', async () => {
		const bad = await callAction('scheduleUpdate', { id: 'x', cron_expr: '0 4 * * *' });
		expect(bad.result).toMatchObject({ status: 400 });
		expect(state.updateCalls).toHaveLength(0);

		const ok = await callAction('scheduleUpdate', {
			id: SCHED_ID,
			cron_expr: '0 5 * * *',
			tz: 'UTC'
		});
		expect(ok.result).toMatchObject({ scheduleChanged: true, watermarkReset: true });
		expect(state.updateCalls[0]).toMatchObject({ id: SCHED_ID, cronExpr: '0 5 * * *', tz: 'UTC' });

		state.updateResult = { kind: 'not-found' };
		expect(
			(await callAction('scheduleUpdate', { id: SCHED_ID, cron_expr: '0 5 * * *' })).result
		).toMatchObject({
			status: 404
		});
	});

	it('scheduleDelete: uuid guard first, then deleted / not-found', async () => {
		const bad = await callAction('scheduleDelete', { id: 'zzz' });
		expect(bad.result).toMatchObject({ status: 400 });
		expect(state.deleteCalls).toHaveLength(0);

		state.deleteResult = { kind: 'not-found' };
		expect((await callAction('scheduleDelete', { id: SCHED_ID })).result).toMatchObject({
			status: 404
		});

		state.deleteResult = { kind: 'deleted', id: SCHED_ID };
		expect((await callAction('scheduleDelete', { id: SCHED_ID })).result).toMatchObject({
			scheduleChanged: true
		});
	});
});
