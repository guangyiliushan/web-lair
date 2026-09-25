import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const links = pgTable(
	'links',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		name: text('name').notNull(),
		url: text('url').notNull(),
		avatar: text('avatar'),
		description: text('description'),
		type: integer('type'),
		state: integer('state'),
		email: text('email')
	},
	(table) => [
		uniqueIndex('links_name_uniq').on(table.name),
		uniqueIndex('links_url_uniq').on(table.url)
	]
);
