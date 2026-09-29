import { describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { pgErrorCode } from '../db/pg-error';
import { jobRuns } from '../db/system/job-run.schema.ts';
import { JOBS } from './registry';
import { enqueueJob } from './queue';

/**
 * Queue semantics (plan §4.4 / T2): insert a `queued` row; a 23505 from the
 * partial unique index means "an active row already exists" - the handler
 * must reuse it instead of surfacing the error. Mocks are plain fakes (the
 * service takes the db as an argument, so no module mocking is needed).
 */
type QueueDb = PostgresJsDatabase<Record<string, never>>;

function makeDb(
	insertSteps: Array<() => Promise<unknown[]>>,
	activeRow: unknown[] = []
): {
	db: QueueDb;
	values: ReturnType<typeof vi.fn>;
	insert: ReturnType<typeof vi.fn>;
} {
	let step = 0;
	const values = vi.fn(() => ({
		returning: () => (insertSteps[step++] ?? (() => Promise.resolve([])))()
	}));
	const insert = vi.fn(() => ({ values }));
	const db = {
		insert,
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => ({
					orderBy: vi.fn(() => ({ limit: vi.fn(async () => activeRow) }))
				}))
			}))
		}))
	} as unknown as QueueDb;
	return { db, values, insert };
}

const duplicate = () => Object.assign(new Error('Failed query'), { cause: { code: '23505' } });

describe('enqueueJob', () => {
	it('inserts a queued row and reports a fresh enqueue', async () => {
		const { db, values } = makeDb([async () => [{ id: 'run-1' }]]);
		const result = await enqueueJob(db, 'system.resources', 'cli');
		expect(result).toEqual({ id: 'run-1', deduplicated: false });
		expect(values).toHaveBeenCalledWith({
			job: 'system.resources',
			trigger: 'cli',
			status: 'queued'
		});
	});

	it('treats the 23505 collision as idempotent and reuses the active row (T2)', async () => {
		// The fake cannot see the SQL status predicate (queued vs running) -
		// the re-select covers both; what matters here is the idempotent reuse.
		const { db } = makeDb([async () => Promise.reject(duplicate())], [{ id: 'run-0' }]);
		const result = await enqueueJob(db, 'system.resources', 'manual');
		expect(result).toEqual({ id: 'run-0', deduplicated: true });
	});

	it('retries once when the blocker finished between insert and re-select', async () => {
		const { db } = makeDb([async () => Promise.reject(duplicate()), async () => [{ id: 'run-2' }]]);
		const result = await enqueueJob(db, 'system.resources', 'cli');
		expect(result).toEqual({ id: 'run-2', deduplicated: false });
	});

	it('surfaces the original 23505 when no active row can be found twice', async () => {
		const { db } = makeDb([
			async () => Promise.reject(duplicate()),
			async () => Promise.reject(duplicate())
		]);
		const error = await enqueueJob(db, 'system.resources', 'cli').catch((err) => err);
		expect(pgErrorCode(error)).toBe('23505');
	});

	it('rethrows non-23505 database errors untouched', async () => {
		const sqlError = Object.assign(new Error('fk violation'), { cause: { code: '23503' } });
		const { db } = makeDb([async () => Promise.reject(sqlError)]);
		await expect(enqueueJob(db, 'system.resources', 'cli')).rejects.toBe(sqlError);
	});

	it('rejects unknown jobs before touching the database', async () => {
		const { db, insert } = makeDb([async () => []]);
		await expect(enqueueJob(db, 'ghost.job', 'cli')).rejects.toThrow('unknown job');
		expect(insert).not.toHaveBeenCalled();
	});

	it('rejects manual runs for jobs flagged manual:false', async () => {
		// JOBS is frozen at the top level, so flip the flag on a definition.
		const definition = JOBS['system.resources'];
		const original = definition.manual;
		definition.manual = false;
		try {
			const { db, insert } = makeDb([async () => []]);
			await expect(enqueueJob(db, 'system.resources', 'manual')).rejects.toThrow(
				'does not allow manual runs'
			);
			await expect(enqueueJob(db, 'system.resources', 'cli')).rejects.toThrow(
				'does not allow manual runs'
			);
			expect(insert).not.toHaveBeenCalled();
		} finally {
			definition.manual = original;
		}
	});
});

// Type-level bridge (J-3 readiness): the admin calls enqueueJob with
// `drizzle(client, { schema })`, whose schema generic makes it NOT assignable
// to the schema-less QueueDb. The generic parameter is what keeps that call
// site cast-free - this function is never invoked, it only needs to compile.
function typeBridge(schemaDb: PostgresJsDatabase<{ jobRuns: typeof jobRuns }>) {
	return enqueueJob(schemaDb, 'system.resources');
}
void typeBridge;

describe('pgErrorCode (shared db helper)', () => {
	it('reads SQLSTATE from both driver shapes and walks the cause chain', () => {
		expect(pgErrorCode({ code: '23505' })).toBe('23505');
		expect(pgErrorCode({ cause: { code: '23505' } })).toBe('23505');
		expect(pgErrorCode({ cause: { cause: { code: '40P01' } } })).toBe('40P01');
		expect(pgErrorCode(new Error('plain'))).toBeUndefined();
		expect(pgErrorCode(null)).toBeUndefined();
	});
});
