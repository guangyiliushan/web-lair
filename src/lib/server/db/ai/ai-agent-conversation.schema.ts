import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const aiAgentConversations = pgTable(
	'ai_agent_conversations',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		sessionId: text('session_id').notNull(),
		model: text('model'),
		providerId: text('provider_id'),
		title: text('title'),
		messages: jsonb('messages')
			.$type<unknown[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date())
	},
	(table) => [index('ai_agent_conversations_session_idx').on(table.sessionId)]
);
