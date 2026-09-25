import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const serverlessLogs = pgTable(
	'serverless_logs',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		functionId: text('function_id'),
		reference: text('reference').notNull(),
		name: text('name').notNull(),
		method: text('method'),
		ip: text('ip'),
		status: text('status').notNull(),
		executionTime: integer('execution_time').notNull(),
		logs: jsonb('logs').$type<unknown[] | null>(),
		error: jsonb('error').$type<Record<string, unknown> | null>()
	},
	(table) => [
		index('serverless_logs_created_at_idx').on(table.createdAt),
		index('serverless_logs_function_idx').on(table.functionId, table.createdAt),
		index('serverless_logs_reference_idx').on(table.reference, table.name, table.createdAt)
	]
);
