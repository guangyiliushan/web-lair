import {
	deriveAcceptedHosts,
	getOption,
	publicOrigin,
	runLinkCheck,
	type JobContext
} from '#jobs-sdk';

/**
 * links.check (links line L2, plan §4.5/§4.6; registered 2026-10-06): one
 * run of the rule-based friend-link checker - due selection, budgeted
 * batches, reachability + backlink checks, evidence-ring and streak updates.
 * Runs under plain Node via the drain; single-flight comes from the drain's
 * own per-job lock (`web_lair.job.links.check`), the CLI shares the key.
 * Imports only `#jobs-sdk` (J-2, plan §5.5) so the file stays fork-runnable
 * from the user layer; options are read through the registry with `ctx.db`
 * injected (the registry is Node-loadable - see the 2026-10-06 ruling).
 */
export default {
	async run(ctx: JobContext): Promise<void> {
		const checks = await getOption('friends.checks', ctx.db);
		const policy = await getOption('friends.policy', ctx.db);
		const origin = publicOrigin();
		const summary = await runLinkCheck({
			db: ctx.db,
			config: checks,
			acceptedHosts: deriveAcceptedHosts(origin, policy.acceptedBacklinkHosts),
			origin,
			logger: {
				info: (line) => ctx.logger.info(line),
				warn: (line) => ctx.logger.warn(line),
				error: (line) => ctx.logger.error(line)
			}
		});
		ctx.summary({
			due: summary.due,
			disabled: summary.disabled,
			checked: summary.checked,
			ok: summary.ok,
			failed: summary.failed,
			skipped: summary.skipped,
			inconclusive: summary.inconclusive,
			writes: summary.writes,
			errors: summary.errors,
			casSkipped: summary.casSkipped,
			transitions: summary.transitions,
			budgetExhausted: summary.budgetExhausted,
			backlinkSkipped: summary.backlinkSkippedReason
		});
	}
};
