import { sql } from 'drizzle-orm';
import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';

export const pages = pgTable(
	'pages',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		title: text('title').notNull(),
		slug: text('slug').notNull(),
		subtitle: text('subtitle'),
		text: text('text'),
		content: text('content'),
		contentFormat: text('content_format').notNull(),
		images: jsonb('images').$type<unknown[]>(),
		meta: jsonb('meta').$type<Record<string, unknown>>(),
		sortOrder: integer('sort_order').notNull().default(1)
	},
	(table) => [
		uniqueIndex('pages_slug_uniq').on(table.slug),
		index('pages_sort_order_idx').on(table.sortOrder)
	]
);
