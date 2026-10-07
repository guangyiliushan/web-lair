import { PROJECT_SYNC_PROVIDERS } from '../../utils/project-meta.ts';
import type { ProjectSyncProvider } from '../../utils/project-meta.ts';
import { isUuid } from '../../utils/uuid.ts';

/**
 * CLI argument parsing for `scripts/jobs/sync-projects.ts` (links cli-args
 * precedent): unknown flags are rejected - a typo must never silently run
 * the sync in WRITE mode. Accepts both `--flag value` and `--flag=value`
 * spellings for the three valued flags.
 */

export interface ProjectsCliArgs {
	dryRun: boolean;
	provider?: ProjectSyncProvider;
	account?: string;
	/** Refresh specific rows by id (uuid), comma-separated. */
	refreshIds?: string[];
}

export type ProjectsCliArgsResult =
	{ ok: true; args: ProjectsCliArgs } | { ok: false; error: string };

const USAGE =
	'usage: pnpm jobs:sync-projects [--dry-run] [--provider <p>] [--account <a>] [--refresh-ids <id,id>]';

export function parseProjectsCliArgs(argv: readonly string[]): ProjectsCliArgsResult {
	let dryRun = false;
	let provider: ProjectSyncProvider | undefined;
	let account: string | undefined;
	let refreshIds: string[] | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--dry-run') {
			dryRun = true;
			continue;
		}
		let flag: string;
		let inlineValue: string | undefined;
		if (arg.startsWith('--') && arg.includes('=')) {
			const eq = arg.indexOf('=');
			flag = arg.slice(0, eq);
			inlineValue = arg.slice(eq + 1);
		} else {
			flag = arg;
		}
		const takeValue = (): string | { error: string } => {
			if (inlineValue !== undefined) return inlineValue;
			const next = argv[index + 1];
			if (typeof next !== 'string') return { error: `${flag} expects a value` };
			index += 1;
			return next;
		};

		if (flag === '--provider') {
			const value = takeValue();
			if (typeof value !== 'string') return { ok: false, error: value.error };
			if (!(PROJECT_SYNC_PROVIDERS as readonly string[]).includes(value)) {
				return {
					ok: false,
					error: `--provider must be one of: ${PROJECT_SYNC_PROVIDERS.join(', ')}`
				};
			}
			provider = value as ProjectSyncProvider;
			continue;
		}
		if (flag === '--account') {
			const value = takeValue();
			if (typeof value !== 'string') return { ok: false, error: value.error };
			if (value.trim().length === 0) return { ok: false, error: '--account must not be empty' };
			account = value.trim();
			continue;
		}
		if (flag === '--refresh-ids') {
			const value = takeValue();
			if (typeof value !== 'string') return { ok: false, error: value.error };
			const ids = value
				.split(',')
				.map((id) => id.trim())
				.filter((id) => id.length > 0);
			if (ids.length === 0) return { ok: false, error: '--refresh-ids expects at least one id' };
			const bad = ids.find((id) => !isUuid(id));
			if (bad !== undefined)
				return { ok: false, error: `--refresh-ids entry is not a uuid: ${bad}` };
			refreshIds = ids;
			continue;
		}
		return { ok: false, error: `unknown argument: ${arg} (${USAGE})` };
	}

	return { ok: true, args: { dryRun, provider, account, refreshIds } };
}
