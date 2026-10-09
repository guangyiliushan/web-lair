import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository root derived from this module's own URL - never from cwd, so
 * the web process, the drain entry (`node jobs/drain.ts`) and tests all
 * resolve the same default data directory (J-2 grill R1-8).
 */
export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * The jobs data directory (jobs-line plan §5.2): an explicit `DATA_DIR` wins -
 * absolute values are used as-is, relative values resolve against cwd; the
 * default is `<repo root>/data` (gitignored in dev; an absolute host-mounted
 * volume in production, ledger §25 backup set).
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.DATA_DIR?.trim();
	if (raw) return isAbsolute(raw) ? raw : resolve(raw);
	return resolve(repoRoot, 'data');
}

/** The user jobs directory inside the data dir (`$DATA_DIR/jobs`). */
export function jobsDir(dataDir: string): string {
	return join(dataDir, 'jobs');
}
