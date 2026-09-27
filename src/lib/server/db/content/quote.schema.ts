import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * "Quotes" (excerpts) waterfall (micro-content line §17): passages collected
 * from books, films and poems. Body column renamed `text` → `content`;
 * `updated_at` added for convention parity.
 */
export const quotes = pgTable(
	'quotes',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		content: text('content').notNull(),
		source: text('source'),
		author: text('author')
	},
	(table) => [index('quotes_created_at_idx').on(table.createdAt)]
);
