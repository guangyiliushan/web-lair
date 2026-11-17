import { runSystemResources, type JobContext } from '#jobs-sdk';

/**
 * system.resources: measure the `DATA_DIR` and `/` mounts plus the cgroup v2
 * memory reading, latch 85%/75% hysteresis alerts (one per metric per UTC
 * day), record every mount in `ctx.summary`, and ping the external
 * healthchecks check.
 *
 * The core lives in `monitoring/system-resources-job.ts` and is loaded lazily
 * through the SDK, so this file stays fork-runnable (imports only `#jobs-sdk`).
 */
export default {
	async run(ctx: JobContext): Promise<void> {
		await runSystemResources(ctx);
	}
};
