import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import {
	MAX_ATTEMPTS,
	TRANSLATION_ABANDONED_ERROR,
	TRANSLATION_CRASH_LOOP_ERROR,
	claimTranslationRow,
	failTranslationAttempt,
	heartbeatTranslation,
	isTranslationCancelled,
	markTranslationWaiting,
	releaseTranslation,
	sweepTranslationCrashLoops
} from './translation-lease';

/**
 * Task B: the lease is the only way a worker can see work, so its SQL shape is
 * the contract — one UPDATE whose subquery locks the row with SKIP LOCKED, a
 * 20-claim crash-loop cap, and a 90s heartbeat staleness window. `runs`
 * (claims) and `attempt` (failures) are separate counters on purpose.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		updates: [] as { table: unknown; values: Record<string, unknown>; where?: unknown }[],
		updateResults: [] as unknown[][],
		selectResults: [] as unknown[][]
	}
}));

const dialect = new PgDialect();
const render = (value: unknown) => dialect.sqlToQuery(value as SQL);
const renderText = (value: unknown) => render(value).sql.replace(/\s+/g, ' ').toLowerCase();

function makeUpdateChain(rows: unknown[]) {
	return (table: unknown) => ({
		set(values: Record<string, unknown>) {
			const call: { table: unknown; values: Record<string, unknown>; where?: unknown } = {
				table,
				values
			};
			state.updates.push(call);
			return {
				where(condition: unknown) {
					call.where = condition;
					const settled = Promise.resolve(rows);
					return {
						returning: async () => rows,
						then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
							settled.then(resolve, reject)
					};
				}
			};
		}
	});
}

function makeSelectChain(rows: unknown[]) {
	return () => {
		const settled = Promise.resolve(rows);
		const chain = {
			from: () => chain,
			where: () => chain,
			limit: () => chain,
			then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
				settled.then(resolve, reject)
		};
		return chain;
	};
}

function claimed(overrides: Record<string, unknown> = {}) {
	return {
		id: 'translation-1',
		attempt: 0,
		runs: 1,
		stage: 'body',
		sourcePostId: 'post-1',
		sourceNoteId: null,
		targetLang: 'en',
		progress: null,
		...overrides
	};
}

beforeEach(() => {
	state.updates = [];
	state.updateResults = [];
	state.selectResults = [];
	dbMock.update = vi.fn(makeUpdateChain([]));
	dbMock.select = vi.fn(() => {
		const chain = makeSelectChain(state.selectResults.shift() ?? []);
		return chain();
	});
});

describe('claimTranslationRow', () => {
	it('claims with one UPDATE whose subquery skips locked rows', async () => {
		state.updateResults = [[claimed()]];
		dbMock.update = vi.fn((table: unknown) => {
			const rows = state.updateResults.shift() ?? [];
			return makeUpdateChain(rows)(table);
		});

		const row = await claimTranslationRow(dbMock as never);

		expect(row).toEqual(claimed());
		// One statement: a select-then-update pair would race two workers.
		expect(state.updates).toHaveLength(1);
		const condition = renderText(state.updates[0].where);
		expect(condition).toContain('select "translations"."id" from "translations"');
		expect(condition).toContain('for update skip locked');
		expect(condition).toContain('"status" = \'draft\'');
		expect(condition).toContain('"content" is null');
		expect(condition).toContain('"error" is null');
		expect(condition).toContain('"runs" < 20');
		expect(condition).toContain('"heartbeat_at" < now() - interval \'90 seconds\'');
		expect(condition).toContain('order by "translations"."created_at"');
		expect(condition).toContain('limit 1');
	});

	it('stamps the lease without consuming a failure attempt', async () => {
		state.updateResults = [[claimed()]];
		dbMock.update = vi.fn((table: unknown) => {
			const rows = state.updateResults.shift() ?? [];
			return makeUpdateChain(rows)(table);
		});

		await claimTranslationRow(dbMock as never);

		const values = state.updates[0].values;
		expect(renderText(values.startedAt)).toBe('now()');
		expect(renderText(values.heartbeatAt)).toBe('now()');
		expect(renderText(values.runs)).toBe('"translations"."runs" + 1');
		expect(renderText(values.stage)).toContain('coalesce');
		expect(values.cancelRequested).toBe(false);
		// A claim ends the previous park: why it was waiting no longer applies.
		expect(values.waitingReason).toBeNull();
		// Claiming is not failing.
		expect(values).not.toHaveProperty('attempt');
		expect(values).not.toHaveProperty('error');
	});

	it('excludes the rows this tick already touched, in one statement', async () => {
		state.updateResults = [[claimed()]];
		dbMock.update = vi.fn((table: unknown) => {
			const rows = state.updateResults.shift() ?? [];
			return makeUpdateChain(rows)(table);
		});

		await claimTranslationRow(dbMock as never, ['translation-1', 'translation-2']);

		// Still one statement: the exclusion lives inside the subquery.
		expect(state.updates).toHaveLength(1);
		const condition = renderText(state.updates[0].where);
		expect(condition).toContain('"translations"."id" not in');
		expect(render(state.updates[0].where).params).toEqual(['translation-1', 'translation-2']);
	});

	it('adds no exclusion clause when the tick has not touched a row', async () => {
		state.updateResults = [[claimed()]];
		dbMock.update = vi.fn((table: unknown) => {
			const rows = state.updateResults.shift() ?? [];
			return makeUpdateChain(rows)(table);
		});

		await claimTranslationRow(dbMock as never, []);

		expect(renderText(state.updates[0].where)).not.toContain('not in');
	});

	it('returns null when nothing is claimable', async () => {
		state.updateResults = [[]];
		dbMock.update = vi.fn((table: unknown) => {
			const rows = state.updateResults.shift() ?? [];
			return makeUpdateChain(rows)(table);
		});

		await expect(claimTranslationRow(dbMock as never)).resolves.toBeNull();
	});

	it('accepts a clock seam for deterministic tests', async () => {
		const at = new Date('2026-11-05T00:00:00.000Z');
		state.updateResults = [[claimed()]];
		dbMock.update = vi.fn((table: unknown) => {
			const rows = state.updateResults.shift() ?? [];
			return makeUpdateChain(rows)(table);
		});

		await claimTranslationRow(dbMock as never, [], at);

		const values = state.updates[0].values;
		expect(render(values.heartbeatAt).params).toEqual([at]);
		// The staleness window always compares against the database clock.
		expect(renderText(state.updates[0].where)).toContain("now() - interval '90 seconds'");
	});
});

describe('sweepTranslationCrashLoops', () => {
	it('abandons only rows that burned every claim without progress', async () => {
		state.updateResults = [[{ id: 'translation-1' }]];
		dbMock.update = vi.fn((table: unknown) => {
			const rows = state.updateResults.shift() ?? [];
			return makeUpdateChain(rows)(table);
		});

		await expect(sweepTranslationCrashLoops(dbMock as never)).resolves.toBe(1);

		const { values, where } = state.updates[0];
		expect(values.error).toBe(TRANSLATION_CRASH_LOOP_ERROR);
		expect(renderText(values.updatedAt)).toBe('now()');
		const condition = renderText(where);
		expect(condition).toContain('"status" = \'draft\'');
		expect(condition).toContain('"content" is null');
		// An already-abandoned row must not be rewritten every tick.
		expect(condition).toContain('"error" is null');
		expect(condition).toContain('"runs" >= 20');
		// A live lease is still generating; never sweep it out from under a worker.
		expect(condition).toContain(
			'"heartbeat_at" is null or "translations"."heartbeat_at" < now() - interval \'90 seconds\''
		);
	});

	it('reports how many rows it abandoned', async () => {
		state.updateResults = [[{ id: 'a' }, { id: 'b' }]];
		dbMock.update = vi.fn((table: unknown) => {
			const rows = state.updateResults.shift() ?? [];
			return makeUpdateChain(rows)(table);
		});

		await expect(sweepTranslationCrashLoops(dbMock as never)).resolves.toBe(2);
	});
});

describe('heartbeat / release / waiting', () => {
	it('heartbeat bumps only the lease clock', async () => {
		await heartbeatTranslation(dbMock as never, 'translation-1');

		const call = state.updates[0];
		expect(renderText(call.values.heartbeatAt)).toBe('now()');
		expect(Object.keys(call.values)).toEqual(['heartbeatAt']);
		expect(render(call.where).params).toEqual(['translation-1']);
	});

	it('release clears the heartbeat so the next tick claims at once', async () => {
		await releaseTranslation(dbMock as never, 'translation-1');

		expect(state.updates[0].values).toEqual({ heartbeatAt: null });
		expect(render(state.updates[0].where).params).toEqual(['translation-1']);
	});

	it('waiting keeps error null, records why, and resets the claim budget', async () => {
		await markTranslationWaiting(dbMock as never, 'translation-1', 'rate limit exceeded');

		const values = state.updates[0].values;
		expect(values.stage).toBe('waiting');
		expect(values.waitingReason).toBe('rate limit exceeded');
		expect(values.error).toBeNull();
		expect(values.heartbeatAt).toBeNull();
		// A clean park is not a crash loop: without this a long rate limit
		// would burn the 20 claims and strand the row as unclaimable.
		expect(values.runs).toBe(0);
		// Finished chunks survive the pause; only the partial preview goes.
		expect(renderText(values.progress)).toContain("- 'partial'");
	});

	it('keeps the claim budget for a network failure', async () => {
		// A connection that never recovers must reach the crash-loop guard
		// instead of being re-claimed (and possibly re-billed) forever.
		await markTranslationWaiting(dbMock as never, 'translation-1', 'connection reset', {
			resetRuns: false
		});

		expect(state.updates[0].values).toEqual({
			stage: 'waiting',
			waitingReason: 'connection reset',
			error: null,
			progress: expect.anything(),
			heartbeatAt: null
		});
		expect(renderText(state.updates[0].values.progress)).toContain("- 'partial'");
	});
});

describe('failTranslationAttempt', () => {
	it('increments the failure counter and clears the lease', async () => {
		state.updateResults = [[{ attempt: 1 }]];
		dbMock.update = vi.fn((table: unknown) => {
			const rows = state.updateResults.shift() ?? [];
			return makeUpdateChain(rows)(table);
		});

		await expect(failTranslationAttempt(dbMock as never, 'translation-1')).resolves.toEqual({
			attempt: 1,
			abandoned: false
		});

		const values = state.updates[0].values;
		expect(renderText(values.attempt)).toBe('"translations"."attempt" + 1');
		expect(values.stage).toBeNull();
		expect(values.waitingReason).toBeNull();
		expect(values.heartbeatAt).toBeNull();
		// Finished chunks survive until the row is abandoned; the fragment the
		// failed attempt was streaming does not.
		const progress = renderText(values.progress);
		expect(progress).toContain('case when');
		expect(progress).toContain("- 'partial'");
		expect(progress).toContain('then null');
		const error = render(values.error);
		expect(error.sql).toContain('case when');
		expect(error.sql).toContain('>= 3');
		// The first two failures must leave `error` NULL: the claim only sees
		// rows without an error, so anything else would strand the retry.
		expect(error.sql).toContain('else null');
		expect(error.params).toEqual([TRANSLATION_ABANDONED_ERROR]);
	});

	it('abandons the row on the third failure', async () => {
		state.updateResults = [[{ attempt: MAX_ATTEMPTS }]];
		dbMock.update = vi.fn((table: unknown) => {
			const rows = state.updateResults.shift() ?? [];
			return makeUpdateChain(rows)(table);
		});

		await expect(failTranslationAttempt(dbMock as never, 'translation-1')).resolves.toEqual({
			attempt: 3,
			abandoned: true
		});
	});

	it('does not write to a row that was discarded mid-run', async () => {
		state.updateResults = [[]];
		dbMock.update = vi.fn((table: unknown) => {
			const rows = state.updateResults.shift() ?? [];
			return makeUpdateChain(rows)(table);
		});

		await expect(failTranslationAttempt(dbMock as never, 'translation-1')).resolves.toEqual({
			attempt: 0,
			abandoned: false
		});
	});
});

describe('isTranslationCancelled', () => {
	it('reports a discard request for a draft row', async () => {
		state.selectResults = [[{ status: 'draft', cancelRequested: true }]];
		await expect(isTranslationCancelled(dbMock as never, 'translation-1')).resolves.toBe(true);
	});

	it('reports a status change', async () => {
		state.selectResults = [[{ status: 'discarded', cancelRequested: false }]];
		await expect(isTranslationCancelled(dbMock as never, 'translation-1')).resolves.toBe(true);
	});

	it('lets a live run continue', async () => {
		state.selectResults = [[{ status: 'draft', cancelRequested: false }]];
		await expect(isTranslationCancelled(dbMock as never, 'translation-1')).resolves.toBe(false);
	});
});
