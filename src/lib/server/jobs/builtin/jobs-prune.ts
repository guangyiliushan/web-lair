import {
	activities,
	aiAgentConversations,
	aiUsage,
	and,
	comments,
	getOption,
	inArray,
	isNotNull,
	jobRuns,
	lt,
	or,
	runTranslationsPrune,
	sql,
	webhookDeliveries,
	type JobContext
} from '#jobs-sdk';

/**
 * jobs.prune (J-1 builtin): trim the ledger tables per the decided retention
 * windows (ledger §24: job_runs 24 months; §26: activities 24 months,
 * webhook_deliveries 30 days; §14.3: ai_usage 24 months). Imports only
 * `#jobs-sdk` (J-2, plan §5.5) so the file stays fork-runnable from the user
 * layer.
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
const AI_USAGE_CUTOFF = sql`now() - interval '24 months'`;
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
		// The AI ledger is a cost record, not an audit trail with legal weight:
		// 24 months is what its schema comment promises. Anything newer stays,
		// which is why this never disturbs the current month's spend.
		const prunedUsage = await ctx.db
			.delete(aiUsage)
			.where(lt(aiUsage.createdAt, AI_USAGE_CUTOFF))
			.returning({ id: aiUsage.id });
		// Chat retention is separate from the 24-month audit windows: only
		// archived conversations are eligible, and 0 disables the prune.
		const chat = await getOption('ai.chat');
		const prunedChats =
			chat.retentionDays > 0
				? await ctx.db
						.delete(aiAgentConversations)
						.where(
							and(
								isNotNull(aiAgentConversations.archivedAt),
								lt(
									aiAgentConversations.updatedAt,
									sql`now() - make_interval(days => ${chat.retentionDays})`
								)
							)
						)
						.returning({ id: aiAgentConversations.id })
				: [];

		// Discarded candidates are the only translation rows that are pure
		// history; the retention window lives in the option, and the sweep is
		// lazy because `translations` pulls the content schema graph.
		const prunedTranslations = await runTranslationsPrune(ctx);

		// W6.2 (C5): comment privacy retention. Only rows that still carry any
		// privacy field are touched, so a site with privacy off pays one cheap
		// no-op query; the raw IP column is never written in the first place.
		const privacy = await getOption('comments.privacy');
		const prunedCommentGeo = privacy.enabled
			? await ctx.db
					.update(comments)
					.set({ countryCode: null, regionCode: null, location: null, agent: null })
					.where(
						and(
							lt(comments.createdAt, sql`now() - make_interval(days => ${privacy.retentionDays})`),
							or(
								isNotNull(comments.countryCode),
								isNotNull(comments.regionCode),
								isNotNull(comments.location),
								isNotNull(comments.agent)
							)
						)
					)
					.returning({ id: comments.id })
			: [];

		ctx.summary({
			jobRuns: prunedRuns.length,
			webhookDeliveries: prunedDeliveries.length,
			activities: prunedActivities.length,
			aiUsage: prunedUsage.length,
			discardedTranslations: prunedTranslations,
			chats: prunedChats.length,
			commentGeo: prunedCommentGeo.length
		});
		ctx.logger.info(
			`pruned job_runs=${prunedRuns.length} webhook_deliveries=${prunedDeliveries.length} activities=${prunedActivities.length} ai_usage=${prunedUsage.length} discarded_translations=${prunedTranslations} chats=${prunedChats.length} comment_geo=${prunedCommentGeo.length}`
		);
	}
};
