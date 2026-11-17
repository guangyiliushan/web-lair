import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/** Explicit repo root (vitest cwd is config-dependent; never assume it). */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * Probe cores strip-only guard: the builtin roster test only imports
 * the builtin wrappers, and a builtin reaches its core through the SDK's
 * dynamic import - so a strip-only landmine inside a core (`$lib`,
 * extensionless relative import, an unresolvable package) would pass that
 * guard and only fail on the production drain tick. Both ops cores are
 * imported in ONE plain Node child, exactly like `node jobs/drain.ts` loads
 * them; one spawn keeps the cost down (the roster guard already spawns per
 * job).
 */
describe('ops probe cores load under plain Node', () => {
	it('imports both cores without a strip-only error', async () => {
		const script =
			"await import('./src/lib/server/monitoring/system-resources-job.ts');" +
			"await import('./src/lib/server/mail/probe-job.ts');";
		// execFile rejects on a non-zero exit, so resolving IS the assertion.
		await expect(
			run(process.execPath, ['--input-type=module', '-e', script], {
				cwd: repoRoot,
				timeout: 30_000
			})
		).resolves.toBeDefined();
	}, 30_000);
});
