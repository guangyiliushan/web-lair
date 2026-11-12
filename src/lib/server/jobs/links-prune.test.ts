import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOptionMock, pruneMock, prunePrechecksMock } = vi.hoisted(() => ({
	getOptionMock: vi.fn(),
	pruneMock: vi.fn(),
	prunePrechecksMock: vi.fn()
}));

/**
 * Only the orchestration is under test: the prune predicate has its own
 * suite, the option registry validates its own schema. Stubbing the SDK keeps
 * the test free of the content-schema graph.
 */
vi.mock('#jobs-sdk', () => ({
	getOption: getOptionMock,
	pruneOutdated: pruneMock,
	prunePrecheckRuns: prunePrechecksMock,
	EMAIL_RETENTION_DAYS: 90,
	links: {
		id: 'links.id',
		email: 'links.email',
		status: 'links.status',
		reviewedAt: 'links.reviewed_at',
		createdAt: 'links.created_at'
	},
	and: (...args: unknown[]) => ({ op: 'and', args }),
	inArray: (col: unknown, values: unknown[]) => ({ op: 'in', col, values }),
	isNotNull: (col: unknown) => ({ op: 'notNull', col }),
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values })
}));

import job from './builtin/links-prune';

interface Stub {
	db: never;
	sets: Record<string, unknown>[];
	wheres: unknown[];
	summary: ReturnType<typeof vi.fn>;
}

function ctx(): Stub {
	const sets: Record<string, unknown>[] = [];
	const wheres: unknown[] = [];
	const summary = vi.fn();
	const db = {
		update: () => ({
			set: (value: Record<string, unknown>) => {
				sets.push(value);
				return {
					where: (clause: unknown) => {
						wheres.push(clause);
						return { returning: async () => [{ id: 'a' }, { id: 'b' }] };
					}
				};
			}
		})
	};
	return {
		db: db as never,
		sets,
		wheres,
		summary
	};
}

beforeEach(() => {
	getOptionMock.mockReset();
	pruneMock.mockReset();
	prunePrechecksMock.mockReset();
	getOptionMock.mockResolvedValue({ graceDays: 14 });
	pruneMock.mockResolvedValue({ graceDays: 14, dryRun: false, matched: 3, deleted: 3 });
	prunePrechecksMock.mockResolvedValue({ matched: 5, deleted: 5 });
});

describe('links.prune builtin', () => {
	it('runs the scheduled prune with the configured grace window', async () => {
		const stub = ctx();
		await job.run({
			db: stub.db,
			summary: stub.summary,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
		} as never);

		expect(pruneMock).toHaveBeenCalledWith({ graceDays: 14 }, { db: stub.db });
	});

	it('clears rejected/banned contact addresses and reports both counts', async () => {
		const stub = ctx();
		await job.run({
			db: stub.db,
			summary: stub.summary,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
		} as never);

		expect(stub.sets[0]).toEqual({ email: null });
		const clause = stub.wheres[0] as { op: string; args: unknown[] };
		expect(clause.op).toBe('and');
		expect(clause.args).toContainEqual({
			op: 'in',
			col: 'links.status',
			values: ['rejected', 'banned']
		});
		expect(stub.summary).toHaveBeenCalledWith({ outdated: 3, emails: 2, prechecks: 5 });
	});
});
