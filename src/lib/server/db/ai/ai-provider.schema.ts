import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import type { AiModelEntry } from '../../../utils/ai-meta.ts';

/**
 * AI provider metadata (AI-1, ledger §14.3). `api_key_env` stores the NAME
 * of the environment variable holding the key - secrets never enter the DB.
 * The row's `models` list feeds the AI-2 provider settings; runtime calls
 * snapshot provider/model strings into `ai_usage`. Each entry carries its own
 * `enabled` flag and discovery timestamp (AI-v3 Q6); cost stays in `ai.pricing`.
 */
export const aiProviders = pgTable(
	'ai_providers',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		name: text('name').notNull(),
		kind: text('kind').notNull(),
		baseUrl: text('base_url'),
		apiKeyEnv: text('api_key_env'),
		models: jsonb('models').$type<AiModelEntry[] | null>(),
		enabled: boolean('enabled').notNull().default(true)
	},
	(table) => [
		check(
			'ai_providers_kind_check',
			sql`${table.kind} in ('openai-compatible', 'deepl', 'custom')`
		),
		uniqueIndex('ai_providers_name_uniq').on(table.name)
	]
);
