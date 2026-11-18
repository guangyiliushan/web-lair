import { and, asc, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { pgErrorCode } from '../db/pg-error.ts';
import { jobRuns } from '../db/system/job-run.schema.ts';
import { JOBS } from './registry.ts';
import type { JobDefinition } from './registry.ts';
import type { JobTrigger } from '../db/system/job-run.schema.ts';

export interface EnqueueResult {
	id: string;
	/** True when an active (queued or running) row already existed. */
	deduplicated: boolean;
}

/**
 * enqueueJob is the manual trigger path: insert `job_runs(status='queued')`; the drain claims it within
 * ~one tick. Double clicks collide with the partial unique index
 * `job_runs_job_queued_uniq(job) WHERE status='queued'` - that 23505 is caught and the active row is
 * reused and reported as `deduplicated`. The index only covers `queued` rows, so a click while the job is
 * RUNNING legitimately queues ONE follow-up run (single-flight still applies per execution); the re-select
 * also covers a blocker that just became `running`. The watermark is never touched here.
 * Callers using the user layer resolve and pass the definition (`resolveJobDefinition`); without one the
 * registry is consulted, keeping the contract for builtin-only callers.
 * Generic over the schema on purpose: the admin surface's `drizzle(client, { schema })` handle is not
 * assignable to the schema-less type the drain uses (the `fullSchema` property makes the generic
 * invariant), so the schema flows in as a type parameter, not a call-site cast.
 */
export async function enqueueJob<TSchema extends Record<string, unknown>>(
	db: PostgresJsDatabase<TSchema>,
	job: string,
	trigger: Extract<JobTrigger, 'manual' | 'cli'> = 'manual',
	definition?: JobDefinition
): Promise<EnqueueResult> {
	const resolved = definition ?? (Object.hasOwn(JOBS, job) ? JOBS[job] : undefined);
	if (!resolved) throw new Error(`unknown job "${job}"`);
	if (!resolved.manual) throw new Error(`job "${job}" does not allow manual runs`);

	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const [row] = await db
				.insert(jobRuns)
				.values({ job, trigger, status: 'queued' })
				.returning({ id: jobRuns.id });
			return { id: row.id, deduplicated: false };
		} catch (err) {
			if (pgErrorCode(err) !== '23505') throw err;
			const [active] = await db
				.select({ id: jobRuns.id })
				.from(jobRuns)
				.where(and(eq(jobRuns.job, job), inArray(jobRuns.status, ['queued', 'running'])))
				.orderBy(asc(jobRuns.createdAt))
				.limit(1);
			if (active) return { id: active.id, deduplicated: true };
			// The blocker finished between our insert and this re-select: try
			// once more, then surface the original error.
			lastError = err;
		}
	}
	throw lastError;
}
