/**
 * CLI argument parsing for `scripts/jobs/check-links.ts`, extracted so the
 * dry-run safety gate has unit teeth (review batch 2026-10-06): unknown
 * flags are rejected - a typo like `--dryrun` must never silently run the
 * checker in WRITE mode.
 */

export interface LinksCliArgs {
	dryRun: boolean;
	limitPerPass?: number;
}

export type LinksCliArgsResult = { ok: true; args: LinksCliArgs } | { ok: false; error: string };

export function parseLinksCliArgs(argv: readonly string[]): LinksCliArgsResult {
	let dryRun = false;
	let limitPerPass: number | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--dry-run') {
			dryRun = true;
			continue;
		}
		if (arg === '--limit') {
			const raw = argv[index + 1];
			// Strict decimal spelling: `Number()` would accept '0x10',
			// '1e3' or padded whitespace (review round 3, 2026-10-06).
			if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < 1) {
				return { ok: false, error: '--limit expects a positive integer' };
			}
			limitPerPass = Number(raw);
			index += 1;
			continue;
		}
		return {
			ok: false,
			error: `unknown argument: ${arg} (usage: pnpm jobs:check-links [--dry-run] [--limit N])`
		};
	}
	return { ok: true, args: { dryRun, limitPerPass } };
}
