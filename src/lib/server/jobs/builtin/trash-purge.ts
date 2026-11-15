import { purgeTrashedPosts, type JobContext } from '#jobs-sdk';

/**
 * trash.purge (M5): delete trashed post families past the grace window, but
 * only when every member of the family is in the trash (a mixed family could
 * hide a still-published translation).
 *
 * Registered as a manual job only: the single-operator ruling (Q5) keeps the
 * trash as an unlimited undo window and leaves the destructive sweep to an
 * explicit CLI/admin run. `ensure-job-schedules` does not seed it.
 */
export default {
	async run(ctx: JobContext): Promise<void> {
		const result = await purgeTrashedPosts({}, { db: ctx.db as never });
		ctx.summary({
			graceDays: result.graceDays,
			candidates: result.candidates,
			deletedFamilies: result.deletedFamilies,
			deletedPosts: result.deletedPosts,
			skippedMixedFamily: result.skippedMixedFamily
		});
		ctx.logger.info(
			`purged trash families=${result.deletedFamilies} posts=${result.deletedPosts} skippedMixed=${result.skippedMixedFamily}`
		);
	}
};
