import { describe, expect, it } from 'vitest';
import { parseLinksCliArgs } from './cli-args';

describe('parseLinksCliArgs (dry-run safety gate, review batch 2026-10-06)', () => {
	it('parses the documented flag combos', () => {
		expect(parseLinksCliArgs([])).toEqual({
			ok: true,
			args: { dryRun: false, limitPerPass: undefined }
		});
		expect(parseLinksCliArgs(['--dry-run'])).toEqual({
			ok: true,
			args: { dryRun: true, limitPerPass: undefined }
		});
		expect(parseLinksCliArgs(['--limit', '7'])).toEqual({
			ok: true,
			args: { dryRun: false, limitPerPass: 7 }
		});
		expect(parseLinksCliArgs(['--limit', '3', '--dry-run'])).toEqual({
			ok: true,
			args: { dryRun: true, limitPerPass: 3 }
		});
	});

	it('rejects typos, bad limits and dangling values (exit-2 contract)', () => {
		expect(parseLinksCliArgs(['--dryrun'])).toEqual({
			ok: false,
			error: 'unknown argument: --dryrun (usage: pnpm jobs:check-links [--dry-run] [--limit N])'
		});
		expect(parseLinksCliArgs(['--limit', '0'])).toEqual({
			ok: false,
			error: '--limit expects a positive integer'
		});
		expect(parseLinksCliArgs(['--limit', 'abc'])).toEqual({
			ok: false,
			error: '--limit expects a positive integer'
		});
		expect(parseLinksCliArgs(['--limit'])).toEqual({
			ok: false,
			error: '--limit expects a positive integer'
		});
		expect(parseLinksCliArgs(['--dry-run', '--bogus']).ok).toBe(false);
	});
});
