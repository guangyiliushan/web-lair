import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';

export type JobResult = Record<string, unknown>;

export type JobTrigger = 'schedule' | 'manual' | 'event' | 'cli';
export type JobRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';

/** Run ledger (jobs line §3.1): one row per execution attempt. */
export const jobRuns = pgTable(
	'job_runs',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		job: text('job').notNull(),
		trigger: text('trigger').notNull(),
		status: text('status').notNull().default('queued'),
		sourceHash: text('source_hash'),
		startedAt: timestamp('started_at', { withTimezone: true }),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		result: jsonb('result').$type<JobResult>(),
		error: text('error')
	},
	(table) => [
		index('job_runs_job_started_at_idx').on(table.job, table.startedAt),
		index('job_runs_status_created_at_idx').on(table.status, table.createdAt),
		// Partial unique: prevent duplicate queued rows per job (T2).
		uniqueIndex('job_runs_job_queued_uniq')
			.on(table.job)
			.where(sql`${table.status} = 'queued'`),
		check(
			'job_runs_trigger_check',
			sql`${table.trigger} in ('schedule', 'manual', 'event', 'cli')`
		),
		check(
			'job_runs_status_check',
			sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'skipped')`
		)
	]
);
