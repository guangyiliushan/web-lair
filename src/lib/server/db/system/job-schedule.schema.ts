import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** Schedule definitions (jobs line §3.2): cron + timezone + enabled flag. */
export const jobSchedules = pgTable(
	'job_schedules',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		job: text('job').notNull(),
		cronExpr: text('cron_expr').notNull(),
		tz: text('tz').notNull().default('UTC'),
		isEnabled: boolean('is_enabled').notNull().default(true),
		lastDueAt: timestamp('last_due_at', { withTimezone: true })
	},
	(table) => [
		uniqueIndex('job_schedules_job_cron_expr_uniq').on(table.job, table.cronExpr),
		index('job_schedules_enabled_idx').on(table.isEnabled)
	]
);
