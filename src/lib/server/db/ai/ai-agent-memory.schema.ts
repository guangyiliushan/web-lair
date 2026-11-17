import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Long-term memory cards: owner-editable notes the assistant carries across
 * conversations; capped at 50 rows (application rule).
 */
export const aiAgentMemories = pgTable('ai_agent_memories', {
	id: uuid('id')
		.primaryKey()
		.default(sql`uuidv7()`)
		.notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
	content: text('content').notNull()
});
