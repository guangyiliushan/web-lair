import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository root, discovered rather than assumed (J-2 review F4/R16): walk
 * up from this module's location to the nearest directory that carries both
 * a package.json and `src/lib/server/jobs/sdk-facade.d.ts`. Inside the repo
 * that is always the repo root - from source (dev, `node jobs/drain.ts`) and
 * from any build output that lives under the repo (`build/…`,
 * `.svelte-kit/output/…`, chunk depth irrelevant). `JOBS_REPO_ROOT`
 * overrides for deployments that move the artifact away from the repository;
 * the historical four-levels-up stays as the final fallback.
 */
function discoverRepoRoot(): string {
	const override = process.env.JOBS_REPO_ROOT?.trim();
	if (override) return resolve(override);
	let dir = fileURLToPath(new URL('.', import.meta.url));
	for (let depth = 0; depth < 12; depth += 1) {
		if (
			existsSync(join(dir, 'package.json')) &&
			existsSync(join(dir, 'src', 'lib', 'server', 'jobs', 'sdk-facade.d.ts'))
		) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return fileURLToPath(new URL('../../../../', import.meta.url));
}

export const repoRoot = discoverRepoRoot();

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
