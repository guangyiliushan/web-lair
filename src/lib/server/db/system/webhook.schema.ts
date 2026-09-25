import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const webhooks = pgTable(
	'webhooks',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		payloadUrl: text('payload_url').notNull(),
		events: text('events').array().notNull(),
		isEnabled: boolean('is_enabled').notNull().default(true),
		secret: text('secret').notNull(),
		scope: integer('scope')
	},
	(table) => [index('webhooks_is_enabled_idx').on(table.isEnabled)]
);
