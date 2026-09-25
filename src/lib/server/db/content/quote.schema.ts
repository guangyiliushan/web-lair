import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const quotes = pgTable(
	'quotes',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		text: text('text').notNull(),
		source: text('source'),
		author: text('author')
	},
	(table) => [index('quotes_created_at_idx').on(table.createdAt)]
);
