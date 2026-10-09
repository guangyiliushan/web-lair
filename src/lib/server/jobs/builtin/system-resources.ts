import { statfs } from 'node:fs/promises';
import os from 'node:os';
import type { JobContext } from '#jobs-sdk';

/**
 * system.resources (J-1 builtin): record host readings into the run result
 * (ledger §25 assigns this job the disk view; thresholds/alerts arrive with
 * the monitoring line - nothing here pages anyone).
 *
 * Notes: `loadavg` is always zero on Windows (platform limitation; the
 * production host is Linux). The disk read covers the current working
 * directory - the deploy root - and will follow the storage layer's data
 * directory once it exists. Imports only `node:*` + `#jobs-sdk` (J-2).
 */
export default {
	async run(ctx: JobContext): Promise<void> {
		const mount = process.cwd();
		const fileSystem = await statfs(mount);
		const totalBytes = fileSystem.blocks * fileSystem.bsize;
		const freeBytes = fileSystem.bavail * fileSystem.bsize;
		const usedPercent =
			totalBytes > 0 ? Math.round((1 - freeBytes / totalBytes) * 1000) / 10 : null;

		const totalMemory = os.totalmem();
		const freeMemory = os.freemem();
		const [load1, load5, load15] = os.loadavg();

		ctx.summary({
			disk: { mount, totalBytes, freeBytes, usedPercent },
			memory: {
				totalBytes: totalMemory,
				freeBytes: freeMemory,
				usedPercent: Math.round((1 - freeMemory / totalMemory) * 1000) / 10
			},
			loadavg: {
				'1m': Math.round(load1 * 100) / 100,
				'5m': Math.round(load5 * 100) / 100,
				'15m': Math.round(load15 * 100) / 100
			},
			uptimeSeconds: Math.round(os.uptime()),
			process: {
				pid: process.pid,
				node: process.version,
				rssBytes: process.memoryUsage().rss
			}
		});
		ctx.logger.info(`disk used=${usedPercent}% free=${freeBytes}B`);
	}
};
