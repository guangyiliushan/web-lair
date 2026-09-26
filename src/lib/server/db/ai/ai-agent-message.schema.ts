import { sql } from 'drizzle-orm';
import {
	check,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	integer
} from 'drizzle-orm/pg-core';
import { aiAgentConversations } from './ai-agent-conversation.schema';

/** Placeholder payload contract for one message; the full shape firms up in AI-2. */
export interface MessageContent {
	text?: string;
	[key: string]: unknown;
}

/**
 * Row-level conversation log (AI-1, ledger §14.3): messages replace the old
 * jsonb array; `seq` orders them inside a conversation (unique). Long threads
 * are compressed into `ai_agent_conversations.summary`; message history is
 * kept in full until manually archived.
 */
export const aiAgentMessages = pgTable(
	'ai_agent_messages',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		conversationId: uuid('conversation_id')
			.notNull()
			.references(() => aiAgentConversations.id, { onDelete: 'cascade' }),
		seq: integer('seq').notNull(),
		role: text('role').notNull(),
		content: jsonb('content').$type<MessageContent>().notNull(),
		model: text('model')
	},
	(table) => [
		check(
			'ai_agent_messages_role_check',
			sql`${table.role} in ('system', 'user', 'assistant', 'tool')`
		),
		uniqueIndex('ai_agent_messages_seq_uniq').on(table.conversationId, table.seq)
	]
);
