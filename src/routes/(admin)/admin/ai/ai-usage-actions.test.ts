import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiUsage } from '$lib/server/db/ai';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

// Action copy comes from the message catalog; pin the locale so assertions stay
// in sync with the zh-cn catalog (same convention as the other route tests).
overwriteGetLocale(() => 'zh-cn');

/**
 * Route-level tests for the ledger wipe (owner-only). The AI console is a
 * read surface with one exception: `ai_usage` has no per-row delete, so a bad
 * import can only be cleaned up wholesale - which is exactly the path that
 * must not be reachable without the owner role.
 *
 * The audit event is `ai.usage_purge`, not `ai.usage.purge`: the activities
 * CHECK admits exactly one dot (`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`), and the
 * old three-segment name raised 23514 AFTER the delete had committed - a 500
 * with the ledger already empty. The wipe therefore runs as one transaction.
 */
const { dbMock, state, authzMock, recordActivityMock } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		counts: [] as unknown[][],
		deletedTables: [] as unknown[],
		tx: null as unknown,
		txOpened: 0
	},
	authzMock: {
		requireAdminRole: vi.fn(async () => {}),
		requireOwnerRole: vi.fn(async () => {}),
		adminContextFor: vi.fn(() => ({ role: 'owner' }))
	},
	recordActivityMock: vi.fn(async () => {})
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => authzMock);
vi.mock('$lib/server/audit', () => ({ recordActivity: recordActivityMock }));

import { actions } from './+page.server';

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

async function callPurge() {
	const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>).purgeUsage;
	return (await fn({ locals: { user: { id: 'owner-1' } } } as never)) as { message?: string };
}

describe('AI console ledger wipe', () => {
	beforeEach(() => {
		state.counts = [];
		state.deletedTables = [];
		state.txOpened = 0;
		authzMock.requireOwnerRole.mockClear();
		recordActivityMock.mockClear();
		// Count, delete and audit all run through the transaction handle; the
		// bare `db` handle is booby-trapped so a future "just use db here" edit
		// fails loudly instead of silently splitting the wipe from its receipt.
		const tx = {
			select: vi.fn(() => makeChain(state.counts.shift() ?? [])),
			delete: vi.fn((table: unknown) => {
				state.deletedTables.push(table);
				return Promise.resolve();
			})
		};
		state.tx = tx;
		Object.assign(dbMock, {
			transaction: vi.fn(async (callback: (handle: unknown) => Promise<unknown>) => {
				state.txOpened += 1;
				return callback(tx);
			}),
			select: vi.fn(() => {
				throw new Error('purge must read through its transaction');
			}),
			delete: vi.fn(() => {
				throw new Error('purge must delete through its transaction');
			})
		});
	});

	it('deletes every usage row and reports the count', async () => {
		state.counts = [[{ total: 7 }]];
		const result = await callPurge();
		expect(result.message).toBe('已清空 7 条用量记录。');
		expect(state.deletedTables).toEqual([aiUsage]);
		expect(authzMock.requireOwnerRole).toHaveBeenCalledTimes(1);
	});

	it('logs who wiped the ledger and how many rows went', async () => {
		state.counts = [[{ total: 3 }]];
		await callPurge();
		expect(recordActivityMock).toHaveBeenCalledWith(
			state.tx,
			expect.objectContaining({
				event: 'ai.usage_purge',
				actorId: 'owner-1',
				payload: { rows: 3 }
			})
		);
	});

	it('records an event name the activities CHECK accepts', async () => {
		// The P0-3 regression tooth: three segments (`ai.usage.purge`) violate
		// the schema CHECK and raise 23514 after the rows are already gone.
		state.counts = [[{ total: 1 }]];
		await callPurge();
		const [, input] = recordActivityMock.mock.calls[0] as unknown as [unknown, { event: string }];
		expect(input.event).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
	});

	it('wipes and logs inside one transaction', async () => {
		state.counts = [[{ total: 2 }]];
		await callPurge();
		expect(state.txOpened).toBe(1);
	});

	it('says so when the ledger was already empty', async () => {
		state.counts = [[{ total: 0 }]];
		const result = await callPurge();
		expect(result.message).toBe('用量记录已经是空的。');
	});

	it('never deletes when the owner gate rejects', async () => {
		authzMock.requireOwnerRole.mockRejectedValueOnce(new Error('forbidden'));
		await expect(callPurge()).rejects.toThrow('forbidden');
		expect(state.deletedTables).toHaveLength(0);
		expect(state.txOpened).toBe(0);
	});
});
