import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	numeric,
	pgTable,
	text,
	timestamp,
	uuid
} from 'drizzle-orm/pg-core';

/**
 * AI call ledger (AI-1, ledger §14.3): one row per model call, named after
 * the OTel GenAI conventions. `provider` / `model` are snapshot strings (no
 * FK) - history must stay true even after a provider is renamed or removed.
 * Usage details are kept for 24 months (retention ledger §14.3).
 */
export const aiUsage = pgTable(
	'ai_usage',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		task: text('task').notNull(),
		provider: text('provider').notNull(),
		model: text('model').notNull(),
		inputTokens: integer('input_tokens'),
		outputTokens: integer('output_tokens'),
		costEstimate: numeric('cost_estimate', { precision: 12, scale: 6 }),
		relatedType: text('related_type'),
		relatedId: uuid('related_id'),
		status: text('status').notNull(),
		durationMs: integer('duration_ms')
	},
	(table) => [
		check(
			'ai_usage_task_check',
			sql`${table.task} in ('summary', 'translation', 'translation_review', 'comment_review', 'chat', 'assistant', 'editor', 'other')`
		),
		check('ai_usage_status_check', sql`${table.status} in ('success', 'failure')`),
		index('ai_usage_created_idx').on(table.createdAt),
		index('ai_usage_task_idx').on(table.task, table.createdAt)
	]
);
