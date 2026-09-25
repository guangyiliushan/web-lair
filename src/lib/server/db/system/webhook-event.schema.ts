import { sql } from 'drizzle-orm';
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid
} from 'drizzle-orm/pg-core';
import { webhooks } from './webhook.schema';

export const webhookEvents = pgTable(
	'webhook_events',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		headers: jsonb('headers').$type<Record<string, unknown> | null>(),
		payload: jsonb('payload').$type<unknown>(),
		event: text('event'),
		response: jsonb('response').$type<unknown>(),
		success: boolean('success'),
		hookId: uuid('hook_id')
			.notNull()
			.references(() => webhooks.id, { onDelete: 'cascade' }),
		status: integer('status').notNull().default(0)
	},
	(table) => [
		index('webhook_events_hook_id_idx').on(table.hookId),
		index('webhook_events_created_at_idx').on(table.createdAt)
	]
);
