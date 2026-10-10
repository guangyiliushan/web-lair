import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the /admin/maintenance/[name] actions (J-3): guard
 * first, the `baseHash` form-field contract (`''` = null = first save, which
 * forks a builtin), the 409 conflict passthrough with the fresh server hash,
 * save-and-run queuing through the re-resolved definition, and the lifecycle
 * actions (revert / delete redirect / ignore update). Services are mocked
 * wholesale; the editor itself is covered by its own browser spec (J-2).
 */

const { mocks, state } = vi.hoisted(() => {
	const state = {
		saveCalls: [] as Record<string, unknown>[],
		revertCalls: [] as Record<string, unknown>[],
		deleteCalls: [] as Record<string, unknown>[],
		ignoreCalls: [] as Record<string, unknown>[],
		enqueueCalls: [] as unknown[][],
		auditCalls: [] as Record<string, unknown>[],
		saveResult: { kind: 'saved', hash: 'newhash', created: false, forked: false } as Record<
			string,
			unknown
		>,
		revertResult: { kind: 'reverted' } as Record<string, unknown>,
		deleteResult: {
			kind: 'deleted',
			schedulesRemoved: 0,
			queuedRemoved: 0,
			runningFinalized: 0
		} as Record<string, unknown>,
		ignoreResult: { kind: 'dismissed', dismissed: ['h'] } as Record<string, unknown>,
		resolveResult: { name: 'my-task', manual: true } as Record<string, unknown> | null
	};
	const mocks = {
		requireAdminRole: vi.fn(async () => {}),
		resolveDataDir: vi.fn(() => '/data'),
		saveScript: vi.fn(async (input: Record<string, unknown>) => {
			state.saveCalls.push(input);
			return state.saveResult;
		}),
		revertToBuiltin: vi.fn(async (input: Record<string, unknown>) => {
			state.revertCalls.push(input);
			return state.revertResult;
		}),
		deleteUserJob: vi.fn(async (input: Record<string, unknown>) => {
			state.deleteCalls.push(input);
			return state.deleteResult;
		}),
		ignoreBuiltinUpdate: vi.fn(async (input: Record<string, unknown>) => {
			state.ignoreCalls.push(input);
			return state.ignoreResult;
		}),
		getScript: vi.fn(async () => null),
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
vi.mock('$lib/server/jobs/job-scripts', () => ({
	saveScript: mocks.saveScript,
	revertToBuiltin: mocks.revertToBuiltin,
	deleteUserJob: mocks.deleteUserJob,
	ignoreBuiltinUpdate: mocks.ignoreBuiltinUpdate,
	getScript: mocks.getScript
}));
vi.mock('$lib/server/jobs/queue', () => ({ enqueueJob: mocks.enqueueJob }));
vi.mock('$lib/server/jobs/user-layer', () => ({
	resolveJobDefinition: mocks.resolveJobDefinition
}));

import { actions, load } from './+page.server';

const guardMock = vi.mocked(mocks.requireAdminRole);
const ACTION_NAMES = ['save', 'saveRun', 'revert', 'delete', 'ignoreUpdate'];

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://x/admin/maintenance/my-task', { method: 'POST', body }),
		params: { name: 'my-task' },
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

function serviceCallCount(): number {
	return (
		state.saveCalls.length +
		state.revertCalls.length +
		state.deleteCalls.length +
		state.ignoreCalls.length +
		state.enqueueCalls.length
	);
}

describe('admin maintenance [name] actions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.saveCalls = [];
		state.revertCalls = [];
		state.deleteCalls = [];
		state.ignoreCalls = [];
		state.enqueueCalls = [];
		state.auditCalls = [];
		state.saveResult = { kind: 'saved', hash: 'newhash', created: false, forked: false };
		state.revertResult = { kind: 'reverted' };
		state.deleteResult = {
			kind: 'deleted',
			schedulesRemoved: 0,
			queuedRemoved: 0,
			runningFinalized: 0
		};
		state.ignoreResult = { kind: 'dismissed', dismissed: ['h'] };
		state.resolveResult = { name: 'my-task', manual: true };
	});

	it('runs requireAdminRole before anything else (all five actions)', async () => {
		for (const name of ACTION_NAMES) {
			guardMock.mockRejectedValueOnce(new Error('redirect: no session'));
			const { thrown } = await callAction(name);
			expect(thrown).toBeInstanceOf(Error);
		}
		expect(serviceCallCount()).toBe(0);
	});

	it('save: maps the empty baseHash to null, passes the code, and folds CRLF back to LF', async () => {
		const ok = await callAction('save', { code: 'export default { run() {} };\n', baseHash: '' });
		expect(ok.result).toMatchObject({ saved: true, hash: 'newhash' });
		expect(state.saveCalls[0]).toMatchObject({
			name: 'my-task',
			code: 'export default { run() {} };\n',
			baseHash: null,
			actorId: 'admin-1'
		});

		await callAction('save', { code: 'x', baseHash: 'abc123' });
		expect(state.saveCalls[1]).toMatchObject({ baseHash: 'abc123' });

		// Multipart submission normalizes line endings to CRLF (undici runs
		// the HTML spec here - observed in this very test); the ingress must
		// fold them back to LF so user files stay LF.
		await callAction('save', { code: 'const a = 1;\r\nconst b = 2;\r', baseHash: 'h' });
		expect(state.saveCalls[2]).toMatchObject({ code: 'const a = 1;\nconst b = 2;\n' });
	});

	it('save: passes gate errors through as 400 and conflicts as 409 with the server hash', async () => {
		state.saveResult = { kind: 'invalid', errors: [{ source: 'typescript', line: 1 }] };
		const invalid = await callAction('save', { code: 'enum E {}', baseHash: '' });
		expect(invalid.result).toMatchObject({ status: 400 });
		expect((invalid.result as { data: { errors: unknown[] } }).data.errors).toHaveLength(1);

		state.saveResult = { kind: 'conflict', currentHash: 'serverhash' };
		const conflict = await callAction('save', { code: 'x', baseHash: 'stale' });
		expect(conflict.result).toMatchObject({ status: 409 });
		expect((conflict.result as { data: Record<string, unknown> }).data).toMatchObject({
			conflict: true,
			currentHash: 'serverhash'
		});
	});

	it('saveRun: queues with the re-resolved definition, audits, then lands on the ledger', async () => {
		const { thrown } = await callAction('saveRun', { code: 'x', baseHash: '' });
		expect(state.enqueueCalls[0][1]).toBe('my-task');
		expect(state.enqueueCalls[0][3]).toEqual({ name: 'my-task', manual: true });
		expect(state.auditCalls[0]).toMatchObject({
			event: 'job.run',
			payload: { name: 'my-task', via: 'save-and-run' }
		});
		// 跳台账 (plan §4.4) - redirect, not a stay-on-page result.
		expect(thrown).toMatchObject({ status: 303, location: '/admin/maintenance' });
	});

	it('saveRun: refuses non-manual definitions and enqueue failures with 400 (J-3 review J3-3)', async () => {
		state.resolveResult = { name: 'my-task', manual: false };
		const nonManual = await callAction('saveRun', { code: 'x', baseHash: '' });
		expect(nonManual.result).toMatchObject({ status: 400 });

		state.resolveResult = { name: 'my-task', manual: true };
		mocks.enqueueJob.mockRejectedValueOnce(new Error('dedupe storm'));
		const failed = await callAction('saveRun', { code: 'x', baseHash: '' });
		expect(failed.result).toMatchObject({ status: 400 });
		expect(state.auditCalls).toHaveLength(0);
	});

	it('load requires the admin role first (J-3 review I1)', async () => {
		guardMock.mockRejectedValueOnce(new Error('redirect: no session'));
		await expect(load({ params: { name: 'my-task' } } as never)).rejects.toThrow(
			'redirect: no session'
		);
	});

	it('saveRun: a conflict never queues', async () => {
		state.saveResult = { kind: 'conflict', currentHash: null };
		const conflict = await callAction('saveRun', { code: 'x', baseHash: 'stale' });
		expect(conflict.result).toMatchObject({ status: 409 });
		expect(state.enqueueCalls).toHaveLength(0);
	});

	it('revert: reports not-a-fork as 400 and success otherwise', async () => {
		state.revertResult = { kind: 'not-forked' };
		expect((await callAction('revert')).result).toMatchObject({ status: 400 });
		state.revertResult = { kind: 'reverted' };
		expect((await callAction('revert')).result).toMatchObject({ reverted: true });
	});

	it('delete: redirects to the list on success, 400 otherwise', async () => {
		state.deleteResult = { kind: 'not-user-job' };
		expect((await callAction('delete')).result).toMatchObject({ status: 400 });

		state.deleteResult = {
			kind: 'deleted',
			schedulesRemoved: 1,
			queuedRemoved: 0,
			runningFinalized: 0
		};
		const { thrown } = await callAction('delete');
		expect(thrown).toMatchObject({ status: 303, location: '/admin/maintenance' });
	});

	it('ignoreUpdate: maps dismissed / not-forked / no-update', async () => {
		expect((await callAction('ignoreUpdate')).result).toMatchObject({ ignored: true });

		state.ignoreResult = { kind: 'not-forked' };
		expect((await callAction('ignoreUpdate')).result).toMatchObject({ status: 400 });
		state.ignoreResult = { kind: 'no-update' };
		expect((await callAction('ignoreUpdate')).result).toMatchObject({ status: 400 });
	});
});
