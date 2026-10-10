import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for /admin/maintenance/new (J-3): guard first, the name
 * requirement, gate-error passthrough, the conflict passthrough, and the
 * redirect contracts - plain save lands on the [name] page, save-and-run
 * queues and lands on the list (ledger visible; plan §4.4).
 */

const { mocks, state } = vi.hoisted(() => {
	const state = {
		saveCalls: [] as Record<string, unknown>[],
		enqueueCalls: [] as unknown[][],
		auditCalls: [] as Record<string, unknown>[],
		saveResult: { kind: 'saved', hash: 'h1', created: true, forked: false } as Record<
			string,
			unknown
		>,
		resolveResult: { name: 'my-task', manual: true } as Record<string, unknown> | null
	};
	const mocks = {
		requireAdminRole: vi.fn(async () => {}),
		resolveDataDir: vi.fn(() => '/data'),
		saveScript: vi.fn(async (input: Record<string, unknown>) => {
			state.saveCalls.push(input);
			return state.saveResult;
		}),
		enqueueJob: vi.fn(async (...args: unknown[]) => {
			state.enqueueCalls.push(args);
			return { id: 'run-1', deduplicated: false };
		}),
		recordActivity: vi.fn(async (_executor: unknown, input: Record<string, unknown>) => {
			state.auditCalls.push(input);
		}),
		resolveJobDefinition: vi.fn(async () => state.resolveResult)
	};
	return { mocks, state };
});

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: mocks.requireAdminRole }));
vi.mock('$lib/server/audit', () => ({ recordActivity: mocks.recordActivity }));
vi.mock('$lib/server/jobs/data-dir', () => ({ resolveDataDir: mocks.resolveDataDir }));
vi.mock('$lib/server/jobs/job-scripts', () => ({ saveScript: mocks.saveScript }));
vi.mock('$lib/server/jobs/queue', () => ({ enqueueJob: mocks.enqueueJob }));
vi.mock('$lib/server/jobs/user-layer', () => ({
	resolveJobDefinition: mocks.resolveJobDefinition
}));

import { actions } from './+page.server';

const guardMock = vi.mocked(mocks.requireAdminRole);

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://x/admin/maintenance/new', { method: 'POST', body }),
		params: {},
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

describe('admin maintenance new actions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.saveCalls = [];
		state.enqueueCalls = [];
		state.auditCalls = [];
		state.saveResult = { kind: 'saved', hash: 'h1', created: true, forked: false };
		state.resolveResult = { name: 'my-task', manual: true };
	});

	it('runs requireAdminRole before anything else (both actions)', async () => {
		for (const name of ['save', 'saveRun']) {
			guardMock.mockRejectedValueOnce(new Error('redirect: no session'));
			const { thrown } = await callAction(name, { name: 'my-task' });
			expect(thrown).toBeInstanceOf(Error);
		}
		expect(state.saveCalls).toHaveLength(0);
	});

	it('save: requires a name and passes the code with baseHash null', async () => {
		const missing = await callAction('save', { code: 'x' });
		expect(missing.result).toMatchObject({ status: 400 });
		expect(state.saveCalls).toHaveLength(0);

		const { thrown } = await callAction('save', { name: 'my-task', code: 'x', baseHash: '' });
		expect(state.saveCalls[0]).toMatchObject({ name: 'my-task', code: 'x', baseHash: null });
		expect(thrown).toMatchObject({ status: 303, location: '/admin/maintenance/my-task' });
	});

	it('save: gate errors pass through as 400 and conflicts as 409', async () => {
		state.saveResult = {
			kind: 'invalid',
			errors: [{ source: 'name', line: null, column: null, message: 'bad' }]
		};
		const invalid = await callAction('save', { name: 'my.job', code: 'x' });
		expect(invalid.result).toMatchObject({ status: 400 });

		state.saveResult = { kind: 'conflict', currentHash: 'h' };
		const conflict = await callAction('save', { name: 'my-task', code: 'x' });
		expect(conflict.result).toMatchObject({ status: 409 });
	});

	it('saveRun: queues with the resolved definition, audits, and lands on the list', async () => {
		const { thrown } = await callAction('saveRun', { name: 'my-task', code: 'x', baseHash: '' });
		expect(state.enqueueCalls[0][1]).toBe('my-task');
		expect(state.auditCalls[0]).toMatchObject({
			event: 'job.run',
			payload: { via: 'save-and-run' }
		});
		expect(thrown).toMatchObject({ status: 303, location: '/admin/maintenance' });

		state.saveResult = { kind: 'conflict', currentHash: null };
		const conflict = await callAction('saveRun', { name: 'my-task', code: 'x' });
		expect(conflict.result).toMatchObject({ status: 409 });
		expect(state.enqueueCalls).toHaveLength(1);
	});
});
