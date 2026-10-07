import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/** Explicit repo root (vitest cwd is config-dependent; never assume it). */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * The `links.check` builtin must load under plain Node type stripping (the
 * drain executes it via `node jobs/drain.ts`). This guard catches strip-only
 * landmines that Vite/vitest transforms would hide: extensionless relative
 * imports and constructor parameter properties both shipped past the unit
 * suite on 2026-10-06 and were only caught by the drain-chain smoke.
 *
 * Lives OUTSIDE `builtin/` on purpose: the roster test pins that directory
 * to exactly the registered job modules.
 */
describe('links.check builtin loads under plain Node', () => {
	it('imports the module graph without a strip-only error', async () => {
		// execFile rejects on a non-zero exit, so resolving IS the assertion.
		await expect(
			run(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					"await import('./src/lib/server/jobs/builtin/links-check.ts')"
				],
				{ cwd: repoRoot, timeout: 30_000 }
			)
		).resolves.toBeDefined();
		// Spawns a real Node child: under full-suite load the 5 s default
		// can cut it off (observed 5012 ms); the child itself stays bounded
		// by the 30 s execFile timeout (review round 2026-10-06).
	}, 20_000);
});

describe('projects.sync builtin loads under plain Node', () => {
	it('imports the module graph without a strip-only error', async () => {
		await expect(
			run(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					"await import('./src/lib/server/jobs/builtin/projects-sync.ts')"
				],
				{ cwd: repoRoot, timeout: 30_000 }
			)
		).resolves.toBeDefined();
	}, 20_000);
});
