import { runCommentReviewJob, type JobContext } from '#jobs-sdk';

/** ai.comment-review: advisory triage events for pending comments. */
export default {
	async run(ctx: JobContext): Promise<void> {
		await runCommentReviewJob(ctx);
	}
};
