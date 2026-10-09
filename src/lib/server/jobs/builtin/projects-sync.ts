import { getOption, runSync, type JobContext } from '#jobs-sdk';

/**
 * projects.sync (projects line C batch; plan §3/§18.3): one run of the
 * four-platform sync over the configured `projects.sync_targets`. Manual by
 * default (enqueued from the admin surface or `pnpm jobs:enqueue
 * projects.sync`); scheduling stays an opt-in per the ledger note.
 * Single-flight = the drain's per-job advisory lock
 * (`web_lair.job.projects.sync`); the CLI shares the key. Imports only
 * `#jobs-sdk` (J-2) so the file stays fork-runnable from the user layer.
 */
export default {
	async run(ctx: JobContext): Promise<void> {
		const targets = await getOption('projects.sync_targets', ctx.db);
		const summary = await runSync({
			db: ctx.db,
			targets,
			logger: ctx.logger
		});
		ctx.summary({
			targets: summary.targets,
			added: summary.added,
			updated: summary.updated,
			skipped: summary.skipped,
			failed: summary.failed,
			// Bound the ledger payload; the full list stays in the logs.
			failures: summary.failures.slice(0, 20)
		});
	}
};
