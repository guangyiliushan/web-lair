import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	uuid
} from 'drizzle-orm/pg-core';
import { comments } from './comment.schema';

/**
 * Comment moderation trail (AI-1, ledger §14.3): one row per rule/AI verdict
 * on a comment. `applied = false` marks shadow-mode decisions (recorded but
 * not enforced); the human axis stays on `comments` alone (§14.4). Rows
 * follow the comment lifecycle via CASCADE.
 */
export const commentModerationEvents = pgTable(
	'comment_moderation_events',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		commentId: uuid('comment_id')
			.notNull()
			.references(() => comments.id, { onDelete: 'cascade' }),
		source: text('source').notNull(),
		ruleId: text('rule_id'),
		model: text('model'),
		score: numeric('score'),
		outcome: text('outcome').notNull(),
		applied: boolean('applied').notNull().default(false),
		detail: jsonb('detail').$type<Record<string, unknown> | null>()
	},
	(table) => [
		check('comment_moderation_events_source_check', sql`${table.source} in ('rule', 'ai')`),
		check(
			'comment_moderation_events_outcome_check',
			sql`${table.outcome} in ('allow', 'hold', 'block')`
		),
		index('comment_moderation_events_comment_idx').on(table.commentId)
	]
);
