import {
	EMAIL_RETENTION_DAYS,
	and,
	getOption,
	inArray,
	isNotNull,
	links,
	pruneOutdated,
	prunePrecheckRuns,
	sql,
	type JobContext
} from '#jobs-sdk';

/**
 * links.prune (links L4 remainder): the scheduled half of the retention
 * promise. Two independent jobs in one pass:
 *
 * - outdated rows past `friends.checks.graceDays` (the CLI's predicate, so the
 *   manual `jobs links-prune` and the schedule cannot disagree);
 * - contact addresses on rejected/banned rows past `EMAIL_RETENTION_DAYS`.
 *   Approved rows keep theirs (they are the only way to reach a live partner);
 *   the public policy states this asymmetry.
 */
export default {
	async run(ctx: JobContext): Promise<void> {
		const checks = await getOption('friends.checks', ctx.db);
		const pruned = await pruneOutdated({ graceDays: checks.graceDays }, { db: ctx.db as never });

		const cleared = await ctx.db
			.update(links)
			.set({ email: null })
			.where(
				and(
					isNotNull(links.email),
					inArray(links.status, ['rejected', 'banned']),
					sql`coalesce(${links.reviewedAt}, ${links.createdAt}) < now() - make_interval(days => ${EMAIL_RETENTION_DAYS})`
				)
			)
			.returning({ id: links.id });

		const prechecks = await prunePrecheckRuns({ db: ctx.db as never });

		ctx.summary({ outdated: pruned.deleted, emails: cleared.length, prechecks: prechecks.deleted });
		ctx.logger.info(
			`pruned outdated=${pruned.deleted} emails=${cleared.length} prechecks=${prechecks.deleted}`
		);
	}
};
