import { describe, expect, it, vi } from 'vitest';
import { purgeTrashedPosts, TRASH_GRACE_DAYS } from './trash.ts';

/**
 * The sweep is a candidate query + one family-count query per candidate; these
 * tests pin the family guard (D3) and the dry-run zero-write contract with a
 * stub `execute`. The real delete path is `purgePostFamily`, covered by the
 * posts route tests and a scratch integration run.
 */
function fakeDb(
	candidates: { id: string; translation_group: string }[],
	counts: { total: number; non_trash: number }[]
) {
	const execute = vi.fn().mockResolvedValueOnce(candidates);
	for (const row of counts) execute.mockResolvedValueOnce([row]);
	return { execute };
}

describe('purgeTrashedPosts', () => {
	it('counts a whole-trashed family but writes nothing in dry-run', async () => {
		const db = fakeDb([{ id: 'src', translation_group: 'g1' }], [{ total: 2, non_trash: 0 }]);
		const result = await purgeTrashedPosts({ dryRun: true }, { db: db as never });

		expect(result).toEqual({
			dryRun: true,
			graceDays: TRASH_GRACE_DAYS,
			candidates: 1,
			deletedFamilies: 1,
			deletedPosts: 2,
			skippedMixedFamily: 0
		});
	});

	it('skips a mixed family instead of deleting a published translation', async () => {
		const db = fakeDb(
			[
				{ id: 'src1', translation_group: 'g1' },
				{ id: 'src2', translation_group: 'g2' }
			],
			[
				{ total: 2, non_trash: 1 },
				{ total: 1, non_trash: 0 }
			]
		);
		const result = await purgeTrashedPosts({ dryRun: true }, { db: db as never });

		expect(result.skippedMixedFamily).toBe(1);
		expect(result.deletedFamilies).toBe(1);
	});

	it('reports zero candidates on a second run', async () => {
		const db = fakeDb([], []);
		const result = await purgeTrashedPosts({}, { db: db as never });

		expect(result.candidates).toBe(0);
		expect(result.deletedFamilies).toBe(0);
	});

	it('honours a grace override', async () => {
		const db = fakeDb([], []);
		const result = await purgeTrashedPosts({ graceDays: 7 }, { db: db as never });

		expect(result.graceDays).toBe(7);
	});

	it('rejects a negative grace', async () => {
		const db = fakeDb([], []);
		await expect(purgeTrashedPosts({ graceDays: -1 }, { db: db as never })).rejects.toThrow(
			/graceDays must be a non-negative integer/
		);
	});
});
