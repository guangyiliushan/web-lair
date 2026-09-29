import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
// Explicit .ts specifier: the jobs drain loads this schema graph under plain
// Node (type stripping); extensionless resolution does not exist there.
import { webhooks } from './webhook.schema.ts';

export type WebhookDeliveryStatus = 'queued' | 'succeeded' | 'failed';

/**
 * Delivery log (platform §D.2, renamed from webhook_events): one row per
 * delivery attempt, queued by the event pipeline and drained by the job runner.
 */
export const webhookDeliveries = pgTable(
	'webhook_deliveries',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		webhookId: uuid('webhook_id')
			.notNull()
			.references(() => webhooks.id, { onDelete: 'cascade' }),
		event: text('event').notNull(),
		payload: jsonb('payload').$type<Record<string, unknown>>(),
		status: text('status').notNull().default('queued'),
		responseCode: integer('response_code'),
		error: text('error'),
		deliveredAt: timestamp('delivered_at', { withTimezone: true })
	},
	(table) => [
		index('webhook_deliveries_status_created_at_idx').on(table.status, table.createdAt),
		index('webhook_deliveries_webhook_id_created_at_idx').on(table.webhookId, table.createdAt),
		check(
			'webhook_deliveries_status_check',
			sql`${table.status} in ('queued', 'succeeded', 'failed')`
		)
	]
);
