import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import type { LocalizedText } from './localized.ts';

/**
 * `categories` labels are per language (SKOS prefLabel): `name` is the source label the slug
 * derives from, `source_lang` records `name`'s language - locked after creation - and `name_i18n`
 * holds the other locales.
 * `is_default` is the fallback bucket that takes posts on clear-out: `posts.category_id` is NOT
 * NULL with `on delete restrict`, so it is not deletable; a partial unique index keeps it to one.
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
			.default(sql`'{}'::jsonb`),
		isDefault: boolean('is_default').notNull().default(false)
	},
	(table) => [
		uniqueIndex('categories_name_uniq').on(table.name),
		uniqueIndex('categories_slug_uniq').on(table.slug),
		// At most one fallback bucket. A partial index over a constant is the
		// usual way to pin "exactly this many" without a trigger.
		uniqueIndex('categories_default_uniq')
			.on(table.isDefault)
			.where(sql`${table.isDefault}`),
		index('categories_sort_order_idx').on(table.sortOrder),
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
