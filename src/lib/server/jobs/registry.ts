/**
 * Job registry (jobs-line plan §5.1): code constants only - metadata lives in
 * git, never in the database. Intentionally import-free so the drain can load
 * it inside a plain Node process (type stripping) and so any layer may depend
 * on it without cycles.
 *
 * Name -> module mapping: `jobs.prune` -> `builtin/jobs-prune.ts` (dots become
 * dashes; module files match /^[a-z0-9-]+\.ts$/, plan §5.1). The advisory-lock
 * key is derived from the name via `jobLockKey` - one source, no stored copy.
 */
export interface JobDefinition {
	/** Registry name, also the `job_runs.job` value (code constant, not an FK). */
	name: string;
	description: string;
	/** Manual (queued) runs allowed (plan §4.4). */
	manual: boolean;
	/** Suggested cron for the admin surface (J-3); informational only. */
	scheduleHint: string | null;
	/** Cooperative in-process timeout; the job promise is raced (plan §5.1). */
	timeoutMs: number;
}

/** `web_lair.job.<name>` namespace (plan §4.3, mirrors the links-line decision). */
export function jobLockKey(name: string): string {
	return `web_lair.job.${name}`;
}

/** Module file name for a registry name: dots become dashes (plan §5.1). */
export function builtinModuleFile(name: string): string {
	return `${name.replaceAll('.', '-')}.ts`;
}

/**
 * J-1 roster. The full planned roster (links.check / projects.sync /
 * revisions.prune / media.* / search.rebuild / ai.* / jobs.typecheck /
 * webhooks.deliver, plan §5.1) is registered line by line as each
 * implementation lands - never ahead of it, so a schedule or manual trigger
 * can never point at code that does not exist.
 *
 * Frozen (shallow) against accidental key writes; the definition objects stay
 * mutable so tests and the J-3 surface can probe them.
 */
export const JOBS: Record<string, JobDefinition> = Object.freeze({
	'jobs.prune': {
		name: 'jobs.prune',
		description:
			'Prune the ledger tables: job_runs and activities older than 24 months, webhook_deliveries older than 30 days.',
		manual: true,
		scheduleHint: '0 4 * * *',
		timeoutMs: 300_000
	},
	'system.resources': {
		name: 'system.resources',
		description:
			'Record host disk / memory / load / uptime readings into the run result (disk thresholds stay with the §25 monitoring line).',
		manual: true,
		scheduleHint: '*/15 * * * *',
		timeoutMs: 30_000
	},
	'links.check': {
		name: 'links.check',
		description:
			'Run the friend-link checker: due selection, reachability + backlink checks, evidence-ring and streak updates (links line plan §4).',
		manual: true,
		scheduleHint: '0 5 * * *',
		timeoutMs: 900_000
	},
	'projects.sync': {
		name: 'projects.sync',
		description:
			'Run the four-platform project sync: fetch public repo lists for the configured accounts and upsert snapshot rows (projects line plan §3).',
		manual: true,
		scheduleHint: null,
		timeoutMs: 900_000
	},
	'jobs.typecheck': {
		name: 'jobs.typecheck',
		description:
			'Type-check the user job scripts (tsc --noEmit against the generated tsconfig in $DATA_DIR/jobs); the bounded result lands in the run ledger.',
		manual: true,
		scheduleHint: null,
		timeoutMs: 180_000
	}
});
