import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const topics = pgTable(
	'topics',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		name: text('name').notNull(),
		slug: text('slug').notNull(),
		description: text('description').notNull().default(''),
		introduce: text('introduce'),
		icon: text('icon')
	},
	(table) => [
		uniqueIndex('topics_name_uniq').on(table.name),
		uniqueIndex('topics_slug_uniq').on(table.slug)
	]
);
