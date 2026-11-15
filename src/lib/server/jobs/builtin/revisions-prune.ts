import { pruneRevisions, type JobContext } from '#jobs-sdk';

/**
 * revisions.prune (M5): keep the newest `REVISION_KEEP_PER_POST` publish
 * snapshots per post and delete the rest (ledger §9.3). The cap is a code
 * constant, not a setting: a single-operator blog has no capacity pressure and
 * a configurable value without a UI would be a dead knob.
 *
 * The summary carries the three numbers the receipt needs: the cap in force,
 * the candidates found, and what was actually deleted. A second run reports
 * zero candidates, which is the idempotency proof.
 */
export default {
	async run(ctx: JobContext): Promise<void> {
		const result = await pruneRevisions({}, { db: ctx.db as never });
		ctx.summary({
			keep: result.keep,
			candidates: result.matched,
			deleted: result.deleted
		});
		ctx.logger.info(`pruned revisions keep=${result.keep} deleted=${result.deleted}`);
	}
};
