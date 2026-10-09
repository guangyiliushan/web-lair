import {
	activities,
	and,
	inArray,
	jobRuns,
	lt,
	sql,
	webhookDeliveries,
	type JobContext
} from '#jobs-sdk';

/**
 * jobs.prune (J-1 builtin): trim the ledger tables per the decided retention
 * windows (ledger §24: job_runs 24 months; §26: activities 24 months,
 * webhook_deliveries 30 days). Imports only `#jobs-sdk` (J-2, plan §5.5) so
 * the file stays fork-runnable from the user layer.
 *
 * Only terminal rows are ever deleted (`succeeded`/`failed`/`skipped` for
 * runs, `succeeded`/`failed` for deliveries): a lingering `queued` row is a
 * signal, not garbage - the drain keeps retrying it, and a `running` row is
 * handled by the stale-reclamation path, not by silent deletion.
 *
 * No batching on purpose: a fresh ledger prunes tens of rows; if the tables
 * ever reach six figures, move to an id-cursor loop (registered).
 */
const JOB_RUNS_CUTOFF = sql`now() - interval '24 months'`;
const ACTIVITIES_CUTOFF = sql`now() - interval '24 months'`;
const WEBHOOK_DELIVERIES_CUTOFF = sql`now() - interval '30 days'`;

export default {
	async run(ctx: JobContext): Promise<void> {
		const prunedRuns = await ctx.db
			.delete(jobRuns)
			.where(
				and(
					lt(jobRuns.createdAt, JOB_RUNS_CUTOFF),
					inArray(jobRuns.status, ['succeeded', 'failed', 'skipped'])
				)
			)
			.returning({ id: jobRuns.id });
		const prunedDeliveries = await ctx.db
			.delete(webhookDeliveries)
			.where(
				and(
					lt(webhookDeliveries.createdAt, WEBHOOK_DELIVERIES_CUTOFF),
					inArray(webhookDeliveries.status, ['succeeded', 'failed'])
				)
			)
			.returning({ id: webhookDeliveries.id });
		const prunedActivities = await ctx.db
			.delete(activities)
			.where(lt(activities.createdAt, ACTIVITIES_CUTOFF))
			.returning({ id: activities.id });

		ctx.summary({
			jobRuns: prunedRuns.length,
			webhookDeliveries: prunedDeliveries.length,
			activities: prunedActivities.length
		});
		ctx.logger.info(
			`pruned job_runs=${prunedRuns.length} webhook_deliveries=${prunedDeliveries.length} activities=${prunedActivities.length}`
		);
	}
};
