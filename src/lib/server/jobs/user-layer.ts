import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jobsDir } from './data-dir.ts';
import { createBuiltinLoader, isSafeJobName } from './loader.ts';
import { JOBS, builtinModuleFile } from './registry.ts';
import type { JobDefinition } from './registry.ts';
import type { JobRunFn, LoadedJob } from './types.ts';

/**
 * User jobs layer (J-2, plan §5.3/§5.5): `$DATA_DIR/jobs` holds the
 * admin-writable job scripts; load order is user > builtin (systemd unit
 * search path precedent). The merged name set is `registry ∪ on-disk user
 * files` (grill R1-2), so user-only jobs (no code constant) run, enqueue and
 * list like builtins. A forked builtin keeps its registry name - its
 * user-layer file is exactly `builtinModuleFile(name)` again.
 */

/** Manual-run default timeout for user-only jobs (grill R1-2; bounds tick stalls). */
export const DEFAULT_USER_JOB_TIMEOUT_MS = 300_000;
/** Sidecar `timeout_ms` bounds (grill R1-2; out-of-range values are ignored). */
export const USER_JOB_TIMEOUT_MIN_MS = 5_000;
export const USER_JOB_TIMEOUT_MAX_MS = 3_600_000;

/** Fork/upgrade sidecar (plan §5.3) plus the R1-2 timeout override. */
export interface UserJobMeta {
	/** sha256 of the builtin source at fork time. */
	builtin_hash?: string;
	forked_at?: string;
	dismissed_hashes?: string[];
	/** Optional cooperative-timeout override (sidecar > registry > default). */
	timeout_ms?: number;
}

/** A user-layer job file: lowercase stem + hyphen, `.ts` only (plan §5.1). */
const USER_JOB_FILE_RE = /^[a-z0-9][a-z0-9-]*\.ts$/;

/** ENOENT/ENOTDIR = genuinely missing; anything else is a real IO failure. */
export function isNotFoundError(error: unknown): boolean {
	const code = (error as { code?: unknown }).code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Module file name for a job name in the user layer (same mapping as builtin). */
export function userJobFileName(name: string): string {
	return builtinModuleFile(name);
}

/** Sidecar path for a job: `.meta/<stem>.json` (plan §5.3). */
export function sidecarPath(dir: string, name: string): string {
	const stem = builtinModuleFile(name).slice(0, -'.ts'.length);
	return join(dir, '.meta', `${stem}.json`);
}

/**
 * Map a user-layer file name back to its job name: a file matching a
 * registered builtin's module name is that builtin's fork; anything else is
 * a user-only job named after its stem (grill R1-2). Returns null for files
 * the layer must ignore (`_sdk.*`, `package.json`, bad names, device names).
 */
export function jobNameForUserFile(fileName: string): string | null {
	if (!USER_JOB_FILE_RE.test(fileName)) return null;
	for (const candidate of Object.keys(JOBS)) {
		if (builtinModuleFile(candidate) === fileName) return candidate;
	}
	const name = fileName.slice(0, -'.ts'.length);
	return isSafeJobName(name) ? name : null;
}

/**
 * Canonical-name invariant (J-2 review F1/D1/D2): a name is usable only when
 * its file mapping points back to itself - a registered name, or a dot-free
 * user name. Aliases (`my.job` maps to `my-job.ts`; `jobs-prune` is the
 * module file of the `jobs.prune` fork) are refused at every entry point
 * (save gate, resolver, loader, delete) so one file can never carry two
 * identities - without this, deleting `my.job` removed another job's file.
 */
export function isCanonicalJobName(name: string): boolean {
	if (Object.hasOwn(JOBS, name)) return true;
	if (!isSafeJobName(name)) return false;
	return jobNameForUserFile(builtinModuleFile(name)) === name;
}

/** Read + validate a sidecar; a missing or malformed file reads as null. */
export async function readUserJobMeta(dir: string, name: string): Promise<UserJobMeta | null> {
	let raw: string;
	try {
		raw = await readFile(sidecarPath(dir, name), 'utf8');
	} catch (error) {
		if (!isNotFoundError(error)) throw error;
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object') return null;
		const meta = parsed as UserJobMeta;
		const timeout = meta.timeout_ms;
		const timeoutMs =
			typeof timeout === 'number' &&
			Number.isInteger(timeout) &&
			timeout >= USER_JOB_TIMEOUT_MIN_MS &&
			timeout <= USER_JOB_TIMEOUT_MAX_MS
				? timeout
				: undefined;
		return {
			builtin_hash: typeof meta.builtin_hash === 'string' ? meta.builtin_hash : undefined,
			forked_at: typeof meta.forked_at === 'string' ? meta.forked_at : undefined,
			dismissed_hashes: Array.isArray(meta.dismissed_hashes)
				? meta.dismissed_hashes.filter((hash): hash is string => typeof hash === 'string')
				: undefined,
			timeout_ms: timeoutMs
		};
	} catch {
		return null;
	}
}

/** Existing user job files (files only, valid names only), sorted. */
export async function listUserJobFiles(dataDir: string): Promise<{ file: string; name: string }[]> {
	const dir = jobsDir(dataDir);
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (!isNotFoundError(error)) throw error;
		return []; // no data dir yet - the scaffold creates it on the next ensure
	}
	const jobs: { file: string; name: string }[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile()) continue;
		const name = jobNameForUserFile(entry.name);
		if (name !== null) jobs.push({ file: entry.name, name });
	}
	return jobs;
}

/** True when a user-layer file exists for this name (path-traversal safe). */
export async function userJobFileExists(dataDir: string, name: string): Promise<boolean> {
	if (!isSafeJobName(name)) return false;
	try {
		const stats = await stat(join(jobsDir(dataDir), userJobFileName(name)));
		return stats.isFile();
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw error;
	}
}

export interface ResolvedJobInfo {
	name: string;
	/** `user` also covers forked builtins (the user file wins at load time). */
	source: 'builtin' | 'user';
}

/** Merged listing (registry ∪ user files) - the J-3 surface reads this. */
export async function listJobs(dataDir: string): Promise<ResolvedJobInfo[]> {
	const userNames = new Set((await listUserJobFiles(dataDir)).map((entry) => entry.name));
	const merged: ResolvedJobInfo[] = [];
	for (const name of Object.keys(JOBS)) {
		merged.push({ name, source: userNames.has(name) ? 'user' : 'builtin' });
		userNames.delete(name);
	}
	for (const name of [...userNames].sort()) merged.push({ name, source: 'user' });
	return merged;
}

/**
 * Merged definition (grill R1-2): registry metadata when the name is a code
 * constant; a user-only default otherwise; `null` when neither a registry
 * entry nor a user file exists. A sidecar `timeout_ms` overrides either.
 */
export async function resolveJobDefinition(
	name: string,
	dataDir: string
): Promise<JobDefinition | null> {
	// Aliases have no identity of their own (J-2 review round 2, D2):
	// resolving one would run another job's file under a phantom name and
	// split the single-flight lock (locks key on the name).
	if (!isCanonicalJobName(name)) return null;
	const registry = Object.hasOwn(JOBS, name) ? JOBS[name] : undefined;
	const meta = await readUserJobMeta(jobsDir(dataDir), name);
	if (registry) {
		const timeout = meta?.timeout_ms;
		return timeout !== undefined ? { ...registry, timeoutMs: timeout } : registry;
	}
	if (!(await userJobFileExists(dataDir, name))) return null;
	return {
		name,
		description: 'User job (no built-in baseline in the repository registry).',
		manual: true,
		scheduleHint: null,
		timeoutMs: meta?.timeout_ms ?? DEFAULT_USER_JOB_TIMEOUT_MS
	};
}

/**
 * Job loader with the user > builtin order (plan §2): a user-layer file for
 * the name wins; otherwise the registry-backed builtin loader runs. The
 * executing source hash always comes from the file that actually ran
 * (plan §3.1 `source_hash`).
 *
 * Per-process memoization (J-2 review R10): plan §2 accepts that a tick
 * reuses the first loaded version. Caching the whole LoadedJob - not just
 * relying on the module cache - is what keeps `source_hash` truthful when a
 * same-tick second execution happens after the file changed: without it the
 * import cache would keep running v1 while the re-read bytes hash v2.
 */
export function createJobLoader(options: {
	dataDir: string;
}): (name: string) => Promise<LoadedJob> {
	const loadBuiltin = createBuiltinLoader();
	const cache = new Map<string, LoadedJob>();
	return async (name) => {
		const cached = cache.get(name);
		if (cached) return cached;
		if (!isCanonicalJobName(name)) {
			throw new Error(
				`job name "${name}" is not canonical (an alias would load another job's file)`
			);
		}
		const filePath = join(jobsDir(options.dataDir), userJobFileName(name));
		let bytes: Buffer;
		try {
			bytes = await readFile(filePath);
		} catch (error) {
			// Only a genuinely missing file falls back to the builtin (J-2
			// review F7): a transient read failure must not silently run
			// different code than the user layer holds.
			if (!isNotFoundError(error)) throw error;
			const fallback = await loadBuiltin(name);
			cache.set(name, fallback);
			return fallback;
		}
		const module = await import(pathToFileURL(filePath).href);
		const run = (module as { default?: { run?: unknown } }).default?.run;
		if (typeof run !== 'function') {
			throw new Error(`user job module for "${name}" must default-export { run(ctx) }`);
		}
		const loaded: LoadedJob = {
			run: run as JobRunFn,
			sourceHash: createHash('sha256').update(bytes).digest('hex')
		};
		cache.set(name, loaded);
		return loaded;
	};
}
