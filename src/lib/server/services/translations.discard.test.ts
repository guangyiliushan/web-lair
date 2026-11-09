import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Task B service wiring: a discard must tell an in-flight run to stop
 * (`cancel_requested`), and a human retry must start a clean run (the failure
 * and claim counters, the stage and the chunk progress all reset) or an
 * abandoned row would re-abandon on its next error.
 */
const { dbMock, state, enqueueJobMock } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		updates: [] as { values: Record<string, unknown>; where?: unknown }[],
		updateResults: [] as unknown[][]
	},
	enqueueJobMock: vi.fn(async () => ({ id: 'job-1', deduplicated: false }))
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/jobs/queue', () => ({ enqueueJob: enqueueJobMock }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(),
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/server/ai/translate', () => ({ sourceHash: () => 'source-hash' }));
vi.mock('./translation-presence', () => ({ hasUsableTranslation: vi.fn(async () => false) }));

import { discardTranslation, retryTranslation } from './translations';

beforeEach(() => {
	state.updates = [];
	state.updateResults = [];
	enqueueJobMock.mockClear();
	dbMock.update = vi.fn(() => ({
		set: (values: Record<string, unknown>) => {
			const call: { values: Record<string, unknown>; where?: unknown } = { values };
			state.updates.push(call);
			return {
				where: (condition: unknown) => {
					call.where = condition;
					return { returning: async () => state.updateResults.shift() ?? [] };
				}
			};
		}
	}));
});

describe('discardTranslation', () => {
	it('sets cancel_requested so a running generation stops', async () => {
		state.updateResults = [[{ id: 'translation-1' }]];

		await expect(discardTranslation('translation-1')).resolves.toEqual({ kind: 'discarded' });

		expect(state.updates).toHaveLength(1);
		expect(state.updates[0].values).toMatchObject({
			status: 'discarded',
			error: null,
			cancelRequested: true
		});
	});

	it('only discards a draft row', async () => {
		state.updateResults = [[]];

		await expect(discardTranslation('translation-1')).resolves.toEqual({ kind: 'not-found' });
		expect(state.updates).toHaveLength(1);
	});
});

describe('retryTranslation', () => {
	it('starts a new run: counters, stage and chunk progress reset', async () => {
		state.updateResults = [[{ id: 'translation-1' }]];

		await expect(retryTranslation('translation-1')).resolves.toEqual({ kind: 'queued' });

		expect(state.updates[0].values).toMatchObject({
			content: null,
			error: null,
			attempt: 0,
			runs: 0,
			stage: null,
			cancelRequested: false,
			overwriteTarget: false,
			progress: null
		});
		expect(enqueueJobMock).toHaveBeenCalledTimes(1);
	});
});
