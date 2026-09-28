import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Webhook endpoint registry (platform §D.2): T1 delivery targets. */
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
		secret: text('secret').notNull(),
		isEnabled: boolean('is_enabled').notNull().default(true)
	},
	(table) => [check('webhooks_payload_url_check', sql`${table.payloadUrl} ~ '^https?://'`)]
);
