import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Short "thoughts" stream (micro-content line §17): atomic personal notes,
 * language-neutral. Renamed from `memos`; the body column is `content`.
 */
export const thoughts = pgTable(
	'thoughts',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		content: text('content').notNull()
	},
	(table) => [index('thoughts_created_at_idx').on(table.createdAt)]
);
