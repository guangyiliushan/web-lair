import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const categories = pgTable(
	'categories',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		name: text('name').notNull(),
		slug: text('slug').notNull(),
		sortOrder: integer('sort_order').notNull().default(0),
		description: text('description')
	},
	(table) => [
		uniqueIndex('categories_name_uniq').on(table.name),
		uniqueIndex('categories_slug_uniq').on(table.slug)
	]
);
