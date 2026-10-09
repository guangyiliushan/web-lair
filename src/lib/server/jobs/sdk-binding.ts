import type { JobsDb } from './types.ts';

/**
 * Run-scoped database binding (J-2, grill R2-3): the drain binds its
 * postgres.js client around each execution, so bare `getOption()` calls and
 * the `db` handle inside job code work without threading `ctx.db` through
 * every call. Outside a run the binding is null and the SDK helpers throw a
 * clear error instead of reaching for the web-only `$lib/server/db` default.
 *
 * The drain executes runs serially inside one process (plan §2), so a single
 * module-level slot has no concurrent writers; the kernel clears it in a
 * finally block after every run.
 */
let boundDb: JobsDb | null = null;

/** Kernel-internal: bind (or clear) the client for the current run. */
export function bindJobDb(db: JobsDb | null): void {
	boundDb = db;
}

/** The client bound to the current run; throws outside a run. */
export function requireBoundDb(): JobsDb {
	if (boundDb === null) {
		throw new Error(
			'jobs SDK: no database is bound to this process - `db` and the bare option helpers only work inside a job run'
		);
	}
	return boundDb;
}
