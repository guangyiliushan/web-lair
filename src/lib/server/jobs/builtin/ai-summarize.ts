import { runSummaryJob, type JobContext } from '#jobs-sdk';

/** ai.summarize: generate candidates for published posts (opt-in). */
export default {
	async run(ctx: JobContext): Promise<void> {
		await runSummaryJob(ctx);
	}
};
