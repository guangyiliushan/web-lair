import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Short admin memos (ledger §6.3 gap closed in P1). */
export const memos = pgTable('memos', {
	id: uuid('id')
		.primaryKey()
		.default(sql`uuidv7()`)
		.notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
	content: text('content').notNull()
});
