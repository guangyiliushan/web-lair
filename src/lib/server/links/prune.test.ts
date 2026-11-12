import { describe, expect, it } from 'vitest';
import {
	parsePruneArgs,
	pruneCutoff,
	pruneOutdated,
	prunePrecheckRuns,
	type PruneDb
} from './prune';

const DAY = 24 * 60 * 60 * 1000;

function fakeDb(rowCount: number): {
	db: PruneDb;
	calls: { deletes: number };
} {
	const calls = { deletes: 0 };
	const db = {
		select: () => ({
			from: () => ({
				where: async () => [{ count: rowCount }]
			})
		}),
		delete: () => ({
			where: () => ({
				returning: async () => {
					calls.deletes += 1;
					return Array.from({ length: rowCount }, (_, i) => ({ id: `id-${i}` }));
				}
			})
		})
	} as unknown as PruneDb;
	return { db, calls };
}

describe('pruneCutoff', () => {
	it('subtracts whole days from the supplied clock', () => {
		const now = new Date('2026-11-09T00:00:00Z');
		expect(pruneCutoff(30, now).toISOString()).toBe(
			new Date(now.getTime() - 30 * DAY).toISOString()
		);
	});
});

describe('parsePruneArgs', () => {
	it('defaults to a real run with the configured grace', () => {
		expect(parsePruneArgs([])).toEqual({
			ok: true,
			args: { dryRun: false, graceDays: null }
		});
	});

	it('accepts --dry-run and a positive --grace-days', () => {
		expect(parsePruneArgs(['--dry-run', '--grace-days', '7'])).toEqual({
			ok: true,
			args: { dryRun: true, graceDays: 7 }
		});
	});

	it('refuses an unknown flag so a typo cannot delete rows', () => {
		expect(parsePruneArgs(['--dry-runn'])).toEqual({
			ok: false,
			error: 'unknown argument: --dry-runn'
		});
	});

	it('refuses a missing or out-of-range grace value', () => {
		expect(parsePruneArgs(['--grace-days'])).toEqual({
			ok: false,
			error: '--grace-days needs a value'
		});
		expect(parsePruneArgs(['--grace-days', '0'])).toEqual({
			ok: false,
			error: '--grace-days must be an integer between 1 and 3650'
		});
		expect(parsePruneArgs(['--grace-days', '1.5'])).toEqual({
			ok: false,
			error: '--grace-days must be an integer between 1 and 3650'
		});
	});
});

describe('pruneOutdated', () => {
	it('dry-run only counts and never calls delete', async () => {
		const { db, calls } = fakeDb(3);
		expect(await pruneOutdated({ graceDays: 30, dryRun: true }, { db })).toEqual({
			graceDays: 30,
			dryRun: true,
			matched: 3,
			deleted: 0
		});
		expect(calls.deletes).toBe(0);
	});

	it('deletes the matching rows and reports the count', async () => {
		const { db, calls } = fakeDb(2);
		expect(await pruneOutdated({ graceDays: 30 }, { db })).toEqual({
			graceDays: 30,
			dryRun: false,
			matched: 2,
			deleted: 2
		});
		expect(calls.deletes).toBe(1);
	});

	it('rejects a non-positive grace window before touching the database', async () => {
		const { db, calls } = fakeDb(1);
		await expect(pruneOutdated({ graceDays: 0 }, { db })).rejects.toThrow(
			'graceDays must be a positive integer'
		);
		expect(calls.deletes).toBe(0);
	});
});

describe('prunePrecheckRuns', () => {
	it('deletes only the rows selected by the window/cap query', async () => {
		const { db, calls } = fakeDb(4);
		expect(await prunePrecheckRuns({ db })).toEqual({ matched: 4, deleted: 4 });
		expect(calls.deletes).toBe(1);
	});

	it('refuses invalid retention knobs before touching the database', async () => {
		const { db, calls } = fakeDb(1);
		await expect(prunePrecheckRuns({ db }, { days: 0 })).rejects.toThrow(
			'days must be a positive integer'
		);
		await expect(prunePrecheckRuns({ db }, { keep: 0 })).rejects.toThrow(
			'keep must be a positive integer'
		);
		expect(calls.deletes).toBe(0);
	});
});
