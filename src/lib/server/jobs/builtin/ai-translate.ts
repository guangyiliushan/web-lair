import { runTranslationJob, type JobContext } from '#jobs-sdk';

/** ai.translate: process a bounded batch of pending translation work items. */
export default {
	async run(ctx: JobContext): Promise<void> {
		await runTranslationJob(ctx);
	}
};
