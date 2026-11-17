/**
 * Job registry: code constants only - metadata lives in
 * git, never in the database. Intentionally import-free so the drain can load
 * it inside a plain Node process (type stripping) and so any layer may depend
 * on it without cycles.
 *
 * Name -> module mapping: `jobs.prune` -> `builtin/jobs-prune.ts` (dots become
 * dashes; module files match /^[a-z0-9-]+\.ts$/). The advisory-lock
 * key is derived from the name via `jobLockKey` - one source, no stored copy.
 */
export interface JobDefinition {
	/** Registry name, also the `job_runs.job` value (code constant, not an FK). */
	name: string;
	description: string;
	/** Manual (queued) runs allowed. */
	manual: boolean;
	/** Suggested cron for the admin surface (J-3); informational only. */
	scheduleHint: string | null;
	/** Cooperative in-process timeout; the job promise is raced. */
	timeoutMs: number;
}

/** `web_lair.job.<name>` namespace (mirrors the links-line decision). */
export function jobLockKey(name: string): string {
	return `web_lair.job.${name}`;
}

/** Module file name for a registry name: dots become dashes. */
export function builtinModuleFile(name: string): string {
	return `${name.replaceAll('.', '-')}.ts`;
}

/**
 * J-1 roster. The full planned roster (links.check / projects.sync /
 * revisions.prune / media.* / search.rebuild / ai.* / jobs.typecheck /
 * webhooks.deliver) is registered line by line as each
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
			'Measure the DATA_DIR and / mounts plus cgroup v2 memory; latch 85%/75% threshold alerts (one per metric per day), record every mount in the run result and ping the external healthchecks check.',
		manual: true,
		scheduleHint: '*/15 * * * *',
		// 30s was too tight once the run includes a 10s healthchecks ping plus one
		// awaited notify per metric; a timeout here aborts the whole drain tick.
		timeoutMs: 45_000
	},
	'mail.probe': {
		name: 'mail.probe',
		description:
			'Verify the SMTP transport daily and send one real probe mail to the owner on Sundays (unique subject, message id in the run result); failures alert through the notification seam and healthchecks.',
		manual: true,
		scheduleHint: '10 5 * * *',
		timeoutMs: 120_000
	},
	'subscriptions.sweep': {
		name: 'subscriptions.sweep',
		description:
			'Delete pending subscription rows older than 30 days (data minimisation; subscribed and unsubscribed rows are never touched).',
		manual: true,
		scheduleHint: '30 4 * * *',
		timeoutMs: 60_000
	},
	'links.check': {
		name: 'links.check',
		description:
			'Run the friend-link checker: due selection, reachability + backlink checks, evidence-ring and streak updates.',
		manual: true,
		scheduleHint: '0 5 * * *',
		timeoutMs: 900_000
	},
	'links.prune': {
		name: 'links.prune',
		description:
			'Delete outdated friend links past the grace window and clear rejected/banned contact addresses past the retention window (links L4).',
		manual: true,
		scheduleHint: '30 5 * * *',
		timeoutMs: 300_000
	},
	'revisions.prune': {
		name: 'revisions.prune',
		description:
			'Delete publish-time post revisions beyond the newest 20 per post; the cap is a code constant.',
		manual: true,
		scheduleHint: '10 3 * * *',
		timeoutMs: 300_000
	},
	'orphans.purge': {
		name: 'orphans.purge',
		description:
			'Clear file references whose polymorphic target is gone (through syncFileReferences) and delete orphan drafts past 30 days; moments excluded.',
		manual: true,
		scheduleHint: '40 3 * * 0',
		timeoutMs: 600_000
	},
	'trash.purge': {
		name: 'trash.purge',
		description:
			'Delete trashed post families past the grace window when every member is trashed; manual only, no default schedule.',
		manual: true,
		scheduleHint: null,
		timeoutMs: 600_000
	},
	'projects.sync': {
		name: 'projects.sync',
		description:
			'Run the four-platform project sync: fetch public repo lists for the configured accounts and upsert snapshot rows.',
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
	},
	'ai.translate': {
		name: 'ai.translate',
		description:
			'Generate pending translation candidates (translations rows with content NULL); never publishes and never overwrites a human edit.',
		manual: true,
		scheduleHint: '*/10 * * * *',
		timeoutMs: 900_000
	},
	'ai.summarize': {
		name: 'ai.summarize',
		description:
			'Generate summary candidates for published posts without an author summary (opt-in via ai.summary.auto).',
		manual: true,
		scheduleHint: '0 4 * * *',
		timeoutMs: 600_000
	},
	'ai.comment-review': {
		name: 'ai.comment-review',
		description:
			'Record advisory AI triage events for pending comments (applied=false; the human queue remains authoritative).',
		manual: true,
		scheduleHint: '*/15 * * * *',
		timeoutMs: 300_000
	}
});
