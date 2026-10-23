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
 * Taxonomy labels are per language (SKOS prefLabel model, ledger §9.18.4 as
 * amended 2026-10-23): `name` is the source label (the one slug is derived
 * from), `name_i18n` holds the other locales. `source_lang` records which
 * language `name` is written in - it is locked after creation.
 *
 * The jsonb constraints keep the column honest without a second table:
 * closed key set, no blank values, and the source locale never duplicated
 * inside `name_i18n` (function form: `?` would collide with the driver's
 * placeholder syntax).
 */
export const categories = pgTable(
	'categories',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		name: text('name').notNull(),
		slug: text('slug').notNull(),
		sortOrder: integer('sort_order').notNull().default(0),
		description: text('description'),
		sourceLang: text('source_lang').notNull().default('zh-cn'),
		nameI18n: jsonb('name_i18n')
			.$type<LocalizedText>()
			.notNull()
			.default(sql`'{}'::jsonb`)
	},
	(table) => [
		uniqueIndex('categories_name_uniq').on(table.name),
		uniqueIndex('categories_slug_uniq').on(table.slug),
		check('categories_source_lang_check', sql`${table.sourceLang} in ('en', 'zh-cn', 'ja')`),
		check('categories_name_i18n_shape_check', sql`jsonb_typeof(${table.nameI18n}) = 'object'`),
		check(
			'categories_name_i18n_keys_check',
			sql`${table.nameI18n} - array['en', 'zh-cn', 'ja'] = '{}'::jsonb`
		),
		check(
			'categories_name_i18n_no_source_check',
			sql`not jsonb_exists(${table.nameI18n}, ${table.sourceLang})`
		),
		check(
			'categories_name_i18n_nonblank_check',
			sql`(${table.nameI18n}->>'en' is null or length(btrim(${table.nameI18n}->>'en')) > 0)
				and (${table.nameI18n}->>'zh-cn' is null or length(btrim(${table.nameI18n}->>'zh-cn')) > 0)
				and (${table.nameI18n}->>'ja' is null or length(btrim(${table.nameI18n}->>'ja')) > 0)`
		)
	]
);
