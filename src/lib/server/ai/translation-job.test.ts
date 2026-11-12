import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';

/**
 * Task B job behaviour: every row is claimed (never selected), real failures
 * increment `attempt`, a rate limit / network / budget pause becomes
 * `stage='waiting'` with `error` still null, and a discard stops the run before
 * it spends more or writes a body.
 */
const { dbMock, state, lease, generateMock } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		writes: [] as { values: Record<string, unknown>; where?: unknown }[],
		writeResults: [] as unknown[][]
	},
	lease: {
		claimTranslationRow: vi.fn(),
		heartbeatTranslation: vi.fn(async () => undefined),
		releaseTranslation: vi.fn(async () => undefined),
		failTranslationAttempt: vi.fn(async () => ({ attempt: 1, abandoned: false })),
		markTranslationWaiting: vi.fn(async () => undefined),
		isTranslationCancelled: vi.fn(async () => false),
		sweepTranslationCrashLoops: vi.fn(async () => 0)
	},
	generateMock: vi.fn()
}));

vi.mock('./translation-lease.ts', () => ({ ...lease, MAX_ATTEMPTS: 3 }));
vi.mock('./translate.ts', () => ({ generateTranslation: generateMock }));

import { AiError } from './errors';
import { runTranslationJob } from './translation-job';
import type { JobContext } from '../jobs/types';

const ROW = {
	id: 'translation-1',
	attempt: 0,
	runs: 1,
	stage: 'body',
	sourcePostId: 'post-1',
	sourceNoteId: null,
	targetLang: 'en',
	progress: null
};

const CANDIDATE = {
	title: 'Translated',
	content: 'Translated body',
	summary: null,
	contentFormat: 'markdown',
	sourceHash: 'hash',
	provider: 'provider',
	model: 'model'
};

const dialect = new PgDialect();

function makeUpdateChain(rows: unknown[]) {
	return () => ({
		set(values: Record<string, unknown>) {
			const call: { values: Record<string, unknown>; where?: unknown } = { values };
			state.writes.push(call);
			return {
				where(condition: unknown) {
					call.where = condition;
					return { returning: async () => rows };
				}
			};
		}
	});
}

function makeCtx() {
	return {
		job: 'ai.translate',
		trigger: 'schedule' as const,
		db: dbMock as unknown as JobContext['db'],
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		summary: vi.fn()
	};
}

function queueClaims(count: number) {
	lease.claimTranslationRow.mockReset();
	for (let index = 0; index < count; index += 1) {
		lease.claimTranslationRow.mockResolvedValueOnce(ROW);
	}
	lease.claimTranslationRow.mockResolvedValue(null);
}

beforeEach(() => {
	state.writes = [];
	state.writeResults = [];
	dbMock.update = vi.fn(() => {
		const rows = state.writeResults.shift() ?? [];
		return makeUpdateChain(rows)();
	});
	generateMock.mockReset();
	generateMock.mockResolvedValue(CANDIDATE);
	lease.claimTranslationRow.mockReset();
	lease.heartbeatTranslation.mockClear();
	lease.releaseTranslation.mockClear();
	lease.failTranslationAttempt.mockReset();
	lease.failTranslationAttempt.mockResolvedValue({ attempt: 1, abandoned: false });
	lease.markTranslationWaiting.mockClear();
	lease.isTranslationCancelled.mockReset();
	lease.isTranslationCancelled.mockResolvedValue(false);
	lease.sweepTranslationCrashLoops.mockClear();
	lease.sweepTranslationCrashLoops.mockResolvedValue(0);
});

describe('runTranslationJob success', () => {
	it('writes the candidate and clears the lease and both counters', async () => {
		queueClaims(1);
		state.writeResults = [[{ id: ROW.id }]];
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		expect(state.writes).toHaveLength(1);
		expect(state.writes[0].values).toMatchObject({
			title: CANDIDATE.title,
			content: CANDIDATE.content,
			contentFormat: CANDIDATE.contentFormat,
			sourceHash: CANDIDATE.sourceHash,
			model: CANDIDATE.model,
			error: null,
			stage: null,
			waitingReason: null,
			heartbeatAt: null,
			// The body supersedes the streaming preview.
			progress: null,
			attempt: 0,
			runs: 0
		});
		const guard = dialect.sqlToQuery(state.writes[0].where as SQL);
		const guardSql = guard.sql.replace(/\s+/g, ' ').toLowerCase();
		expect(guardSql).toContain('"status" =');
		expect(guardSql).toContain('"content" is null');
		expect(guardSql).toContain('"cancel_requested" =');
		expect(guard.params).toEqual([ROW.id, 'draft', false]);
		expect(ctx.summary).toHaveBeenCalledWith({
			claimed: 1,
			generated: 1,
			failed: 0,
			waiting: 0,
			cancelled: 0,
			deadlineHit: false
		});
	});

	it('persists chunk progress before the terminal write', async () => {
		queueClaims(1);
		// Two chunk snapshots plus the terminal candidate write.
		state.writeResults = [[], [], [{ id: ROW.id }]];
		generateMock.mockImplementation(
			async (input: {
				onPlan?: (plan: {
					sourceHash: string;
					total: number;
					maxChars: number;
					prior: null;
				}) => void;
				onChunk?: (index: number, text: string) => void;
			}) => {
				input.onPlan?.({ sourceHash: 'hash', total: 2, maxChars: 3000, prior: null });
				input.onChunk?.(0, 'A');
				input.onChunk?.(1, 'B');
				return CANDIDATE;
			}
		);
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		const snapshots = state.writes
			.map((write) => write.values.progress)
			.filter(
				(value): value is { total: number; done: number } =>
					Boolean(value) && typeof value === 'object'
			);
		expect(snapshots).toHaveLength(2);
		expect(snapshots[0]).toMatchObject({ total: 2, done: 1 });
		expect(snapshots[1]).toMatchObject({ total: 2, done: 2 });
	});

	it('streams the body into progress.partial before the candidate lands', async () => {
		queueClaims(1);
		state.writeResults = [[{ id: ROW.id }]];
		generateMock.mockImplementation(async (input: { onProgress?: (text: string) => void }) => {
			input.onProgress?.('半成品');
			return CANDIDATE;
		});
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		// The preview write is followed by the terminal write that clears it.
		// The payload is a SQL merge (jsonb_set) so a future chunked run keeps
		// its chunks instead of having them replaced by one preview frame.
		const preview = state.writes[0].values as { progress: SQL };
		const rendered = dialect.sqlToQuery(preview.progress);
		expect(rendered.sql).toContain('jsonb_set');
		expect(rendered.params).toContain('半成品');
		expect(state.writes[1].values).toMatchObject({ content: CANDIDATE.content, progress: null });
	});

	it('processes at most one batch of claims per tick', async () => {
		queueClaims(5);
		state.writeResults = [[{ id: ROW.id }], [{ id: ROW.id }], [{ id: ROW.id }]];
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		expect(lease.claimTranslationRow).toHaveBeenCalledTimes(3);
		expect(ctx.summary).toHaveBeenCalledWith(expect.objectContaining({ claimed: 3, generated: 3 }));
	});

	it('never re-claims a row this tick already handled', async () => {
		lease.claimTranslationRow.mockReset();
		lease.claimTranslationRow
			.mockResolvedValueOnce(ROW)
			.mockResolvedValueOnce({ ...ROW, id: 'translation-2' })
			.mockResolvedValue(null);
		state.writeResults = [[{ id: ROW.id }], [{ id: 'translation-2' }]];
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		expect(lease.claimTranslationRow).toHaveBeenNthCalledWith(1, dbMock, []);
		expect(lease.claimTranslationRow).toHaveBeenNthCalledWith(2, dbMock, [ROW.id]);
		expect(lease.claimTranslationRow).toHaveBeenNthCalledWith(3, dbMock, [ROW.id, 'translation-2']);
	});

	it('sweeps crash-loop rows before the first claim', async () => {
		queueClaims(1);
		state.writeResults = [[{ id: ROW.id }]];
		lease.sweepTranslationCrashLoops.mockResolvedValue(2);
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		expect(lease.sweepTranslationCrashLoops).toHaveBeenCalledWith(dbMock);
		expect(lease.sweepTranslationCrashLoops.mock.invocationCallOrder[0]).toBeLessThan(
			lease.claimTranslationRow.mock.invocationCallOrder[0]
		);
		expect(ctx.logger.warn.mock.calls.flat().join(' ')).toContain('2 crash-loop row(s)');
	});
});

describe('runTranslationJob failures', () => {
	it('counts a timeout as a failed attempt, not a waiting pause', async () => {
		queueClaims(1);
		generateMock.mockRejectedValue(new AiError('timeout', 'provider timed out'));
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		expect(lease.failTranslationAttempt).toHaveBeenCalledWith(dbMock, ROW.id);
		expect(lease.markTranslationWaiting).not.toHaveBeenCalled();
		expect(state.writes).toHaveLength(0);
		expect(ctx.summary).toHaveBeenCalledWith(expect.objectContaining({ failed: 1, waiting: 0 }));
	});

	it.each([
		['rate_limit', true],
		['network', false],
		['budget', true]
	] as const)('turns %s into stage=waiting with a cleared lease', async (code, resetRuns) => {
		queueClaims(1);
		generateMock.mockRejectedValue(new AiError(code, 'not the row`s fault'));
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		expect(lease.markTranslationWaiting).toHaveBeenCalledWith(
			dbMock,
			ROW.id,
			'not the row`s fault',
			// Only a provider/budget pause may reuse the claim budget; a
			// network failure keeps counting toward the crash-loop guard.
			{ resetRuns }
		);
		expect(lease.failTranslationAttempt).not.toHaveBeenCalled();
		expect(state.writes).toHaveLength(0);
		expect(ctx.summary).toHaveBeenCalledWith(expect.objectContaining({ failed: 0, waiting: 1 }));
	});

	it('parks two different rows instead of spinning on the first one', async () => {
		// Before the exclusion, the first parked row still matched the claim
		// predicate and each `continue` claimed it again, burning `runs` and
		// leaving the second row untouched.
		lease.claimTranslationRow.mockReset();
		lease.claimTranslationRow
			.mockResolvedValueOnce(ROW)
			.mockResolvedValueOnce({ ...ROW, id: 'translation-2' })
			.mockResolvedValue(null);
		generateMock.mockRejectedValue(new AiError('rate_limit', 'slow down'));
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		expect(lease.claimTranslationRow).toHaveBeenNthCalledWith(2, dbMock, [ROW.id]);
		expect(lease.markTranslationWaiting).toHaveBeenCalledTimes(2);
		expect(ctx.summary).toHaveBeenCalledWith(expect.objectContaining({ claimed: 2, waiting: 2 }));
	});

	it('reports an abandoned row after the third failure', async () => {
		queueClaims(1);
		generateMock.mockRejectedValue(new AiError('invalid_output', 'truncated'));
		lease.failTranslationAttempt.mockResolvedValue({ attempt: 3, abandoned: true });
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		expect(lease.failTranslationAttempt).toHaveBeenCalledWith(dbMock, ROW.id);
		expect(ctx.logger.warn.mock.calls.flat().join(' ')).toContain('abandoned');
	});
});

describe('runTranslationJob cancel', () => {
	it('stops before generating when the row was discarded while queued', async () => {
		queueClaims(1);
		lease.isTranslationCancelled.mockResolvedValue(true);
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		expect(generateMock).not.toHaveBeenCalled();
		expect(state.writes).toHaveLength(0);
		expect(ctx.summary).toHaveBeenCalledWith(expect.objectContaining({ cancelled: 1 }));
	});

	it('stops before writing the body when a discard raced the generation', async () => {
		queueClaims(1);
		lease.isTranslationCancelled.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		expect(generateMock).toHaveBeenCalledTimes(1);
		expect(state.writes).toHaveLength(0);
		expect(ctx.summary).toHaveBeenCalledWith(
			expect.objectContaining({ cancelled: 1, generated: 0 })
		);
	});

	it('does not overwrite a body that a racing retry reset', async () => {
		queueClaims(1);
		// The guarded update matched no row: a discard/retry won the race.
		state.writeResults = [[]];
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		expect(ctx.summary).toHaveBeenCalledWith(
			expect.objectContaining({ generated: 0, cancelled: 1 })
		);
	});
});

describe('runTranslationJob empty queue', () => {
	it('summarizes a tick with no claimable row', async () => {
		lease.claimTranslationRow.mockResolvedValue(null);
		const ctx = makeCtx();

		await runTranslationJob(ctx);

		expect(state.writes).toHaveLength(0);
		expect(ctx.summary).toHaveBeenCalledWith({
			claimed: 0,
			generated: 0,
			failed: 0,
			waiting: 0,
			cancelled: 0,
			deadlineHit: false
		});
	});
});
