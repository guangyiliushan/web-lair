import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Permanent deletion is the only path that removes a candidate row, so it has
 * to be as narrow as the discard rule: a discarded row goes, a draft still
 * owning a job and an accepted row still owning a live target both stay.
 */
const { dbMock, state } = vi.hoisted(() => {
	const state = {
		selectQueue: [] as unknown[][],
		returningQueue: [] as unknown[][],
		deletes: 0,
		updates: 0
	};
	return { dbMock: {} as Record<string, unknown>, state };
});

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/jobs/queue', () => ({ enqueueJob: vi.fn(async () => ({ id: 'job-1' })) }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => ({ minChars: 0, defaultMode: 'manual' })),
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/server/ai/translate', () => ({ sourceHash: () => 'source-hash' }));
vi.mock('./translation-presence', () => ({ hasUsableTranslation: vi.fn(async () => false) }));
vi.mock('./post-drafts', () => ({ isPlaceholderSlug: () => false, tempSlug: () => 'temp-slug' }));
vi.mock('./file-references', () => ({
	keysFromContent: () => [],
	syncFileReferences: vi.fn(async () => {})
}));

import { deleteTranslation } from './translations';

const CANDIDATE = '44444444-4444-4444-4444-444444444444';

function selectChain(): Record<string, unknown> {
	const chain: Record<string, unknown> = {};
	const ret = () => chain;
	Object.assign(chain, {
		from: ret,
		where: ret,
		orderBy: ret,
		limit: ret,
		for: ret,
		innerJoin: ret,
		leftJoin: ret,
		then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
			Promise.resolve(state.selectQueue.shift() ?? []).then(resolve, reject)
	});
	return chain;
}

function writeChain(): Record<string, unknown> {
	const chain: Record<string, unknown> = {};
	const ret = () => chain;
	Object.assign(chain, {
		set: ret,
		values: ret,
		where: ret,
		onConflictDoNothing: ret,
		returning: async () => state.returningQueue.shift() ?? [],
		then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
			Promise.resolve(undefined).then(resolve, reject)
	});
	return chain;
}

beforeEach(() => {
	state.selectQueue = [];
	state.returningQueue = [];
	state.deletes = 0;
	state.updates = 0;
	dbMock.select = vi.fn(() => selectChain());
	dbMock.insert = vi.fn(() => writeChain());
	dbMock.update = vi.fn(() => {
		state.updates += 1;
		return writeChain();
	});
	dbMock.delete = vi.fn(() => {
		state.deletes += 1;
		return writeChain();
	});
});

describe('deleteTranslation', () => {
	it('removes a discarded row and returns the deleted kind', async () => {
		state.returningQueue = [[{ id: CANDIDATE }]];

		await expect(deleteTranslation(CANDIDATE)).resolves.toEqual({ kind: 'deleted' });

		expect(state.deletes).toBe(1);
		// Having found the row under the discarded guard, no follow-up read is needed.
		expect(state.selectQueue).toHaveLength(0);
		expect(state.updates).toBe(0);
	});

	it('refuses a row that is still a draft', async () => {
		// The delete matched nothing (status guard), then the lookup reports why.
		state.returningQueue = [[]];
		state.selectQueue = [[{ status: 'draft' }]];

		await expect(deleteTranslation(CANDIDATE)).resolves.toEqual({ kind: 'not-discarded' });
		expect(state.deletes).toBe(1);
	});

	it('refuses an accepted row, which still owns a live target', async () => {
		state.returningQueue = [[]];
		state.selectQueue = [[{ status: 'accepted' }]];

		await expect(deleteTranslation(CANDIDATE)).resolves.toEqual({ kind: 'not-discarded' });
	});

	it('reports a row that is already gone as not found', async () => {
		state.returningQueue = [[]];
		state.selectQueue = [[]];

		await expect(deleteTranslation(CANDIDATE)).resolves.toEqual({ kind: 'not-found' });
	});
});
