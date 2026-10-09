import { runJobsTypecheck, type JobContext } from '#jobs-sdk';

/**
 * jobs.typecheck (J-2, plan §4.11): type-check the user job scripts with the
 * repository's tsc against the generated tsconfig in `$DATA_DIR/jobs`, and
 * record a bounded diagnostic summary in the run result (the J-3 surface
 * renders it). The save gate does not type-check (plan §5.4); this job is
 * the on-demand verification path, also usable as a schedule.
 */
export default {
	async run(ctx: JobContext): Promise<void> {
		const summary = await runJobsTypecheck();
		ctx.summary({
			ok: summary.ok,
			files: summary.fileCount,
			errors: summary.errorCount,
			issues: summary.issues,
			timedOut: summary.timedOut,
			runnerError: summary.runnerError
		});
		ctx.logger.info(
			`typecheck ${summary.ok ? 'passed' : 'failed'}: ${summary.fileCount} file(s), ${summary.errorCount} error(s)`
		);
	}
};
