import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Webhook endpoint registry: event delivery targets. */
export const webhooks = pgTable(
	'webhooks',
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
		name: text('name').notNull(),
		payloadUrl: text('payload_url').notNull(),
		events: text('events').array().notNull(),
		/**
		 * Legacy plaintext signing secret. New rows write NULL and store
		 * the value encrypted in `webhook_secrets`; this column stays readable
		 * only until the backfill has run, so an un-migrated endpoint keeps
		 * verifying and a rollback is symmetric.
		 */
		secret: text('secret'),
		isEnabled: boolean('is_enabled').notNull().default(true)
	},
	(table) => [check('webhooks_payload_url_check', sql`${table.payloadUrl} ~ '^https?://'`)]
);
