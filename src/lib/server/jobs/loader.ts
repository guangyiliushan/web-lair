import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { JOBS, builtinModuleFile } from './registry.ts';
import type { JobRunFn, LoadedJob } from './types.ts';

/**
 * Job names become module file names, so they must never carry path
 * segments, and the mapped stem must not be a Windows device name (reserved
 * for every extension - "con.ts" is the console). Registry names are code
 * constants today; the J-2 user layer will feed this from files, which is why
 * the check is a named, tested gate.
 */
export function isSafeJobName(name: string): boolean {
	if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) return false;
	const stem = builtinModuleFile(name).slice(0, -'.ts'.length);
	return !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(stem);
}

/**
 * Builtin job loader: resolves a registry name to `builtin/<name>.ts` and
 * loads it under plain Node type stripping. Split out of drain.ts because the
 * J-2 user layer (`$DATA_DIR/jobs`, user > builtin) layers on top of exactly
 * this resolution step.
 */
export function createBuiltinLoader(): (name: string) => Promise<LoadedJob> {
	return async (name) => {
		if (!Object.hasOwn(JOBS, name)) throw new Error(`unknown job "${name}"`);
		if (!isSafeJobName(name)) throw new Error(`job name "${name}" is not a valid module name`);
		const moduleUrl = new URL(`./builtin/${builtinModuleFile(name)}`, import.meta.url);
		const [module, bytes] = await Promise.all([import(moduleUrl.href), readFile(moduleUrl)]);
		const run = (module as { default?: { run?: unknown } }).default?.run;
		if (typeof run !== 'function') {
			throw new Error(`job module for "${name}" must default-export { run(ctx) }`);
		}
		return {
			run: run as JobRunFn,
			// sha256 of the executing source file (plan §3.1 `source_hash`).
			sourceHash: createHash('sha256').update(bytes).digest('hex')
		};
	};
}
