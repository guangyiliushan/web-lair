import { sql } from 'drizzle-orm';
import {
	boolean,
	index,
	integer,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';

/**
 * The default model pool: an ordered list of MODEL ids, not providers.
 *
 * Why models: a model is the thing the operator actually chooses ("translate
 * with deepseek-v4-pro"). Which provider serves it is a runtime detail - every
 * enabled provider that offers the model is a candidate, so adding a second
 * gateway automatically gives that model a fallback without any extra
 * configuration. Rows here are the operator's opt-in: a model that is not in
 * the pool keeps today's single-provider behaviour.
 */
export const aiModelPool = pgTable(
	'ai_model_pool',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		model: text('model').notNull(),
		/**
		 * Order within the chain. Deliberately NOT unique: a swap passes through
		 * two rows sharing a position, so the writer rewrites the whole 0..n-1
		 * range and readers fall back to `created_at`.
		 */
		position: integer('position').notNull().default(0),
		enabled: boolean('enabled').notNull().default(true),
		/**
		 * Month-to-date spend cap for this model, in `ai.budget.currency`.
		 * 0 = no cap. A model over its cap is skipped in favour of the next pool
		 * entry rather than failing the call outright.
		 */
		monthlyBudget: numeric('monthly_budget', { precision: 12, scale: 2 }).notNull().default('0')
	},
	(table) => [
		uniqueIndex('ai_model_pool_model_uniq').on(table.model),
		index('ai_model_pool_order_idx').on(table.position)
	]
);
