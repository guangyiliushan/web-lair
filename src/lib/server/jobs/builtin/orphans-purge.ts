import { purgeOrphans, type JobContext } from '#jobs-sdk';

/**
 * orphans.purge: clean file references whose polymorphic target is gone
 * (through `syncFileReferences`, so `files.status` stays correct) and delete
 * orphan drafts older than the grace window. `moments` stay out of scope -
 * nothing writes their ref columns yet.
 *
 * Weekly: orphan accumulation is slow and the file-reference sweep is the only
 * part that touches media state.
 */
export default {
	async run(ctx: JobContext): Promise<void> {
		const result = await purgeOrphans({}, { db: ctx.db as never });
		ctx.summary({
			refGroups: result.refGroups,
			refRows: result.refRows,
			drafts: result.drafts,
			draftGraceDays: result.draftGraceDays,
			skippedMoments: result.skippedMoments
		});
		ctx.logger.info(
			`purged orphans refs=${result.refRows}/${result.refGroups} drafts=${result.drafts}`
		);
	}
};
