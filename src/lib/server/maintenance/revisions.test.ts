import { describe, expect, it, vi } from 'vitest';
import { pruneRevisions, REVISION_KEEP_PER_POST } from './revisions.ts';

/**
 * The SQL is a ranked delete; these tests pin the contract around it (defaults,
 * dry-run zero-write, idempotent counting) with a stub `execute`. The real DB
 * shape is exercised by a scratch integration run.
 */
function fakeDb(rows: unknown[]) {
	return { execute: vi.fn(async () => rows) };
}

describe('pruneRevisions', () => {
	it('defaults to the per-post cap and reports the candidates in dry-run', async () => {
		const db = fakeDb([{ n: 3 }]);
		const result = await pruneRevisions({ dryRun: true }, { db: db as never });

		expect(result).toEqual({ keep: REVISION_KEEP_PER_POST, dryRun: true, matched: 3, deleted: 0 });
		expect(db.execute).toHaveBeenCalledTimes(1);
	});

	it('deletes on a real run and reports the deleted count', async () => {
		const db = fakeDb([{ id: 'a' }, { id: 'b' }]);
		const result = await pruneRevisions({}, { db: db as never });

		expect(result).toEqual({ keep: REVISION_KEEP_PER_POST, dryRun: false, matched: 2, deleted: 2 });
	});

	it('reports zero on a second run (idempotent on a fixed tree)', async () => {
		const db = fakeDb([]);
		const result = await pruneRevisions({}, { db: db as never });

		expect(result.deleted).toBe(0);
	});

	it('honours a keep override', async () => {
		const db = fakeDb([{ id: 'a' }]);
		const result = await pruneRevisions({ keep: 5 }, { db: db as never });

		expect(result.keep).toBe(5);
	});

	it('rejects a non-positive keep so a typo cannot wipe history', async () => {
		const db = fakeDb([]);
		await expect(pruneRevisions({ keep: 0 }, { db: db as never })).rejects.toThrow(
			/keep must be a positive integer/
		);
		expect(db.execute).not.toHaveBeenCalled();
	});
});
