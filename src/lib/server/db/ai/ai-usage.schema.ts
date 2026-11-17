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
// Explicit .ts specifier: the jobs drain loads this schema graph under plain
// Node (type stripping); extensionless resolution does not exist there.
import { user } from '../auth.schema.ts';

/**
 * AI call ledger: one row per model call, named after the OTel GenAI
 * conventions. `provider` / `model` are snapshot strings (no FK) - history
 * must stay true even after a provider is renamed or removed.
 * Usage details are kept for 24 months.
 *
 * `actor_id` / `trigger` are the cost-attribution pair: who caused the
 * call, and whether it came from a manual action, a job, the agent or an
 * API token. The action-level audit stays in `activities`; this table
 * answers "how much did this actor spend".
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
		/**
		 * Snapshot of the model the function slot asked for. It equals `model`
		 * unless the chain fell back to a different pool model - that difference
		 * is the only way to answer "how often did we leave the preferred model".
		 */
		requestedModel: text('requested_model'),
		actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
		trigger: text('trigger'),
		inputTokens: integer('input_tokens'),
		outputTokens: integer('output_tokens'),
		costEstimate: numeric('cost_estimate', { precision: 12, scale: 6 }),
		relatedType: text('related_type'),
		relatedId: uuid('related_id'),
		status: text('status').notNull(),
		durationMs: integer('duration_ms'),
		audioSeconds: integer('audio_seconds')
	},
	(table) => [
		check(
			'ai_usage_task_check',
			sql`${table.task} in ('summary', 'translation', 'translation_review', 'comment_review', 'chat', 'assistant', 'editor', 'transcription', 'other')`
		),
		check('ai_usage_status_check', sql`${table.status} in ('success', 'failure')`),
		index('ai_usage_created_idx').on(table.createdAt),
		index('ai_usage_task_idx').on(table.task, table.createdAt),
		// Per-member health on the aggregation card: "how did this provider do
		// in the last 24h" is asked once per member, so the pair needs an index.
		index('ai_usage_provider_idx').on(table.provider, table.createdAt),
		index('ai_usage_actor_idx')
			.on(table.actorId, table.createdAt)
			.where(sql`${table.actorId} is not null`),
		// "What did this post/note cost": the editor links here with both columns, so
		// the range predicate rides the third key instead of scanning created_at.
		index('ai_usage_related_idx')
			.on(table.relatedType, table.relatedId, table.createdAt)
			.where(sql`${table.relatedId} is not null`)
	]
);
