import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { JobResult, JobTrigger } from '../db/system/job-run.schema.ts';

/**
 * The jobs runtime's database surface (jobs-line plan §2, §5.5).
 *
 * Deliberately NOT `$lib/server/db`: that module reads `$env/dynamic/private`
 * (a SvelteKit virtual module), while the drain runs as a plain Node process
 * (`node jobs/drain.ts`) that builds its own postgres.js client. The schema
 * generic stays `Record<string, never>` so the same code accepts whichever
 * client the caller wires up.
 */
export type JobsDb = PostgresJsDatabase<Record<string, never>>;

/** Query surface shared by a db handle and a transaction handle. */
export type JobsQueryable = Pick<JobsDb, 'select' | 'insert' | 'update' | 'delete'>;

/** Prefixed logger handed to job code (SDK surface, plan §5.5). */
export interface JobLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}

/** Runtime context passed to a job's `run` (plan §5.5, J-1 subset). */
export interface JobContext {
	/** Registry name of the executing job. */
	job: string;
	trigger: JobTrigger;
	db: JobsQueryable;
	logger: JobLogger;
	/** Merge counts/notes into `job_runs.result` (JSON-serializable, never secrets). */
	summary(data: JobResult): void;
}

export type JobRunFn = (ctx: JobContext) => Promise<void> | void;

/** A resolved job implementation plus its execution-version hash. */
export interface LoadedJob {
	run: JobRunFn;
	/** sha256 of the executing source file (plan §3.1 `source_hash`). */
	sourceHash: string;
}
