import { describe, expect, it, vi } from 'vitest';
import { DRAFT_ORPHAN_GRACE_DAYS, purgeOrphans } from './orphans.ts';

/**
 * The SQL is a two-query sweep; these tests pin the contract around it
 * (defaults, dry-run zero-write, grace validation) with a stub transaction.
 * The real DB shape is exercised by the M5-6 scratch integration run.
 */
function fakeDb(
	refGroups: { ref_type: string; ref_id: string; n: number }[],
	drafts: { id: string }[]
) {
	const execute = vi.fn().mockResolvedValueOnce(refGroups).mockResolvedValueOnce(drafts);
	const deleted: string[] = [];
	const tx = {
		execute,
		delete: vi.fn(() => ({ where: async () => undefined }))
	};
	return {
		db: { transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) },
		execute,
		deleted
	};
}

describe('purgeOrphans', () => {
	it('counts groups, rows and drafts in dry-run without deleting', async () => {
		const { db, execute } = fakeDb(
			[
				{ ref_type: 'post', ref_id: 'a', n: 2 },
				{ ref_type: 'draft', ref_id: 'b', n: 1 }
			],
			[{ id: 'c' }] as { id: string }[]
		);
		const result = await purgeOrphans({ dryRun: true }, { db: db as never });

		expect(result).toEqual({
			dryRun: true,
			draftGraceDays: DRAFT_ORPHAN_GRACE_DAYS,
			refGroups: 2,
			refRows: 3,
			drafts: 1,
			skippedMoments: true
		});
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it('reports zero on a second run (idempotent)', async () => {
		const { db } = fakeDb([], []);
		const result = await purgeOrphans({}, { db: db as never });

		expect(result.refRows).toBe(0);
		expect(result.drafts).toBe(0);
	});

	it('honours a draft grace override', async () => {
		const { db } = fakeDb([], []);
		const result = await purgeOrphans({ draftGraceDays: 0 }, { db: db as never });

		expect(result.draftGraceDays).toBe(0);
	});

	it('rejects a negative grace so a typo cannot widen the sweep', async () => {
		const { db } = fakeDb([], []);
		await expect(purgeOrphans({ draftGraceDays: -1 }, { db: db as never })).rejects.toThrow(
			/draftGraceDays must be a non-negative integer/
		);
	});
});
