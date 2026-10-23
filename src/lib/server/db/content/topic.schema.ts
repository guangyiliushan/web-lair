import { sql } from 'drizzle-orm';
import {
	check,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import type { LocalizedText } from './localized';

/**
 * Same label model as `categories` (ledger §9.18.4 as amended 2026-10-23):
 * `name` / `description` are the source labels, the `*_i18n` columns hold the
 * other locales. `description_i18n` exists here (unlike categories) because
 * the topic page renders it - `topics/[slug]/+page.svelte` prints the
 * description, while the category index never does.
 */
export const topics = pgTable(
	'topics',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		name: text('name').notNull(),
		slug: text('slug').notNull(),
		description: text('description').notNull().default(''),
		icon: text('icon'),
		sortOrder: integer('sort_order').notNull().default(0),
		sourceLang: text('source_lang').notNull().default('zh-cn'),
		nameI18n: jsonb('name_i18n')
			.$type<LocalizedText>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		descriptionI18n: jsonb('description_i18n')
			.$type<LocalizedText>()
			.notNull()
			.default(sql`'{}'::jsonb`)
	},
	(table) => [
		uniqueIndex('topics_name_uniq').on(table.name),
		uniqueIndex('topics_slug_uniq').on(table.slug),
		check('topics_source_lang_check', sql`${table.sourceLang} in ('en', 'zh-cn', 'ja')`),
		check('topics_name_i18n_shape_check', sql`jsonb_typeof(${table.nameI18n}) = 'object'`),
		check(
			'topics_name_i18n_keys_check',
			sql`${table.nameI18n} - array['en', 'zh-cn', 'ja'] = '{}'::jsonb`
		),
		check(
			'topics_name_i18n_no_source_check',
			sql`not jsonb_exists(${table.nameI18n}, ${table.sourceLang})`
		),
		check(
			'topics_name_i18n_nonblank_check',
			sql`(${table.nameI18n}->>'en' is null or length(btrim(${table.nameI18n}->>'en')) > 0)
				and (${table.nameI18n}->>'zh-cn' is null or length(btrim(${table.nameI18n}->>'zh-cn')) > 0)
				and (${table.nameI18n}->>'ja' is null or length(btrim(${table.nameI18n}->>'ja')) > 0)`
		),
		check(
			'topics_description_i18n_shape_check',
			sql`jsonb_typeof(${table.descriptionI18n}) = 'object'`
		),
		check(
			'topics_description_i18n_keys_check',
			sql`${table.descriptionI18n} - array['en', 'zh-cn', 'ja'] = '{}'::jsonb`
		),
		check(
			'topics_description_i18n_no_source_check',
			sql`not jsonb_exists(${table.descriptionI18n}, ${table.sourceLang})`
		),
		check(
			'topics_description_i18n_nonblank_check',
			sql`(${table.descriptionI18n}->>'en' is null or length(btrim(${table.descriptionI18n}->>'en')) > 0)
				and (${table.descriptionI18n}->>'zh-cn' is null or length(btrim(${table.descriptionI18n}->>'zh-cn')) > 0)
				and (${table.descriptionI18n}->>'ja' is null or length(btrim(${table.descriptionI18n}->>'ja')) > 0)`
		)
	]
);
