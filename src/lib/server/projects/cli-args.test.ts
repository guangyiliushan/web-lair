import { describe, expect, it } from 'vitest';
import { parseProjectsCliArgs } from './cli-args';

/**
 * CLI teeth (links cli-args precedent): unknown flags and malformed values
 * are rejected BEFORE any run starts - a typo like `--dryrun` must never
 * silently execute the sync in WRITE mode.
 */
describe('parseProjectsCliArgs', () => {
	const UUID = '0191ca43-1a2b-7c3d-8e4f-5a6b7c8d9e0f';

	it('parses flags in both spellings, trims the account', () => {
		const spaced = parseProjectsCliArgs([
			'--dry-run',
			'--provider',
			'github',
			'--account',
			' guang ',
			'--refresh-ids',
			`${UUID},${UUID}`
		]);
		expect(spaced).toEqual({
			ok: true,
			args: {
				dryRun: true,
				provider: 'github',
				account: 'guang',
				refreshIds: [UUID, UUID]
			}
		});
		const inline = parseProjectsCliArgs(['--provider=gitlab', '--account=guang']);
		expect(inline).toEqual({
			ok: true,
			args: { dryRun: false, provider: 'gitlab', account: 'guang' }
		});
	});

	it('defaults to an empty filter set', () => {
		expect(parseProjectsCliArgs([])).toEqual({ ok: true, args: { dryRun: false } });
	});

	it('rejects unknown arguments with usage guidance', () => {
		const result = parseProjectsCliArgs(['--dryrun']);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('unknown argument: --dryrun');
	});

	it('rejects off-platform providers and empty accounts', () => {
		const bad = parseProjectsCliArgs(['--provider', 'site']);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain('--provider must be one of');
		const empty = parseProjectsCliArgs(['--account', '   ']);
		expect(empty.ok).toBe(false);
	});

	it('validates every refresh id as a uuid', () => {
		const bad = parseProjectsCliArgs(['--refresh-ids', 'not-a-uuid']);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain('not a uuid');
	});

	it('rejects a valued flag without a value', () => {
		const result = parseProjectsCliArgs(['--provider']);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('expects a value');
	});

	it('never swallows a following flag as a value (review 2026-10-08)', () => {
		const result = parseProjectsCliArgs(['--account', '--dry-run']);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('expects a value');
	});

	it('caps the refresh id list', () => {
		const ids = Array.from(
			{ length: 501 },
			(_, index) => `0191ca43-1a2b-7c3d-8e4f-${String(index).padStart(12, '0')}`
		);
		const result = parseProjectsCliArgs(['--refresh-ids', ids.join(',')]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('at most 500');
	});
});
