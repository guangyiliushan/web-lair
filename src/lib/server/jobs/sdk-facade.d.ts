/**
 * Jobs SDK type facade (J-2, plan §5.5) - the hand-written, self-contained
 * surface user job scripts see through `#jobs-sdk`.
 *
 * Self-contained on purpose: the generated tsconfig in `$DATA_DIR/jobs`
 * type-checks user scripts against this file alone, without walking the
 * repository dependency graph (which needs SvelteKit aliases such as `$lib`).
 * A unit test asserts the value-level export names here match the runtime
 * module (`jobs-sdk.ts`) in both directions: every runtime export must be
 * declared, every declaration must exist at runtime.
 *
 * Deliberately shallow: helpers return wide types where a precise drizzle
 * signature would drag the repository graph into the user-side program.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- deliberately shallow
   facade: precise drizzle signatures would drag the repository dependency
   graph into the user-side type-check program */

/** Prefixed logger handed to job code. */
export interface JobLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}

/** How the run was triggered (matches `job_runs.trigger`). */
export type JobTrigger = 'schedule' | 'manual' | 'event' | 'cli';

/** Counts / notes merged into `job_runs.result` (JSON-serializable, never secrets). */
export type JobResult = Record<string, unknown>;

/**
 * Structural view of the database handle. The drain binds its postgres.js
 * client for the duration of each run, so `db` / `getDb()` are usable only
 * from inside `run(ctx)`.
 */
export interface JobDb {
	execute(query: unknown): Promise<unknown>;
	select(...args: any[]): any;
	insert(...args: any[]): any;
	update(...args: any[]): any;
	delete(...args: any[]): any;
}

/** Runtime context passed to a job's `run`. */
export interface JobContext {
	/** Job name as registered / listed in the admin surface. */
	job: string;
	trigger: JobTrigger;
	/** Same handle as `getDb()` for this run. */
	db: JobDb;
	logger: JobLogger;
	/** Merge counts / notes into `job_runs.result`. */
	summary(data: JobResult): void;
}

/**
 * The bound database handle (identical to `ctx.db` during a run). Using it
 * outside a run throws.
 */
export declare const db: JobDb;

/** Function form of the bound handle; throws outside a run. */
export declare function getDb(): JobDb;

/** Read a validated option (falls back to the registered default). */
export declare function getOption(key: string, executor?: JobDb): Promise<any>;

/** Validate and upsert an option. Throws on invalid values / unknown keys. */
export declare function setOption(key: string, value: unknown, executor?: JobDb): Promise<void>;

/** drizzle SQL helpers re-exported for job scripts. */
export declare function sql(strings: TemplateStringsArray | string, ...values: any[]): any;
export declare function and(...conditions: any[]): any;
export declare function or(...conditions: any[]): any;
export declare function eq(left: any, right: any): any;
export declare function ne(left: any, right: any): any;
export declare function lt(left: any, right: any): any;
export declare function lte(left: any, right: any): any;
export declare function gt(left: any, right: any): any;
export declare function gte(left: any, right: any): any;
export declare function inArray(column: any, values: any[]): any;
export declare function notInArray(column: any, values: any[]): any;
export declare function isNull(column: any): any;
export declare function isNotNull(column: any): any;
export declare function desc(column: any): any;
export declare function asc(column: any): any;

/** Ledger tables: `job_runs` / `activities` / `webhook_deliveries`. */
export declare const jobRuns: any;
export declare const activities: any;
export declare const webhookDeliveries: any;

/** Friend-link checker services (links line). */
export declare function runLinkCheck(input: any): Promise<any>;
export declare function deriveAcceptedHosts(origin: string, accepted: string[]): string[];
export declare function publicOrigin(): string;

/** Four-platform projects sync (projects line). */
export declare function runSync(input: any): Promise<any>;

/** Type-check the user job scripts (jobs.typecheck) - bounded summary. */
export declare function runJobsTypecheck(options?: {
	dataDir?: string;
	maxIssues?: number;
}): Promise<any>;
