import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from '../auth.schema.ts';
import { aiAgentConversations } from './ai-agent-conversation.schema.ts';

/**
 * A proposed settings write. The agent can only create a pending
 * row; the human confirms in the chat UI. `argsHash` binds the proposal to its
 * key/before/after so a mutated row cannot be confirmed silently. Expired rows
 * are ignored by the UI and rejected by the action.
 */
export const aiAgentProposals = pgTable(
	'ai_agent_proposals',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		conversationId: uuid('conversation_id')
			.notNull()
			.references(() => aiAgentConversations.id, { onDelete: 'cascade' }),
		actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
		settingKey: text('setting_key').notNull(),
		before: jsonb('before').$type<unknown>(),
		after: jsonb('after').$type<unknown>(),
		argsHash: text('args_hash').notNull(),
		status: text('status').notNull().default('pending'),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		resolvedAt: timestamp('resolved_at', { withTimezone: true })
	},
	(table) => [
		check(
			'ai_agent_proposals_status_check',
			sql`${table.status} in ('pending', 'confirmed', 'rejected', 'expired')`
		),
		index('ai_agent_proposals_conversation_idx').on(table.conversationId, table.status),
		// Leading index for the SET NULL FK check.
		index('ai_agent_proposals_actor_idx')
			.on(table.actorId)
			.where(sql`${table.actorId} is not null`),
		index('ai_agent_proposals_expiry_idx')
			.on(table.expiresAt)
			.where(sql`${table.status} = 'pending'`)
	]
);
