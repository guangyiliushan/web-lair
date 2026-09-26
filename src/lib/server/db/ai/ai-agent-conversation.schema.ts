import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from '../auth.schema';

/**
 * Admin-only assistant conversations (reshaped in AI-1, ledger §14.3):
 * session/model/messages moved out - messages are row-level now
 * (ai_agent_messages), closing threads leave a `summary`, and `archived_at`
 * marks manual archives. Owner/managers only; full history retained.
 */
export const aiAgentConversations = pgTable(
	'ai_agent_conversations',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
		title: text('title'),
		summary: text('summary'),
		archivedAt: timestamp('archived_at', { withTimezone: true })
	},
	(table) => [
		index('ai_agent_conversations_user_idx')
			.on(table.userId)
			.where(sql`${table.userId} is not null`)
	]
);
