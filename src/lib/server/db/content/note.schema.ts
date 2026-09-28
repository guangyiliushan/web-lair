import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
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
import { topics } from './topic.schema';

/** Notes meta contract (micro-content line §17): per-note translation / AI settings. */
export interface NotesMeta {
	translate?: { mode?: 'auto' | 'review' | 'manual'; targets?: string[] };
	aiGen?: { level: 'none' | 'assist' | 'generated' };
	[key: string]: unknown;
}

/**
 * Notes are multi-language like posts (micro-content line §17, flipping the
 * earlier single-language decision): `lang` + `translation_group` +
 * `(lang, slug)` unique; translations are separate rows that share the
 * source `nid` (application-level contract) and point at the group source
 * via `translated_from_note_id`. Deleting a group source is a group-level
 * flow (ledger §14.4/§17): while translations exist the DB refuses the
 * delete outright (the SET NULL pass would collide with
 * notes_group_source_uniq), so group cleanup happens in application code.
 */
export const notes = pgTable(
	'notes',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		lang: text('lang').notNull().default('en'),
		translationGroup: uuid('translation_group')
			.notNull()
			.default(sql`uuidv7()`),
		translatedFromNoteId: uuid('translated_from_note_id').references((): AnyPgColumn => notes.id, {
			onDelete: 'set null'
		}),
		translationOrigin: text('translation_origin'),
		nid: integer('nid').notNull().generatedByDefaultAsIdentity(),
		title: text('title'),
		slug: text('slug'),
		text: text('text'),
		content: text('content'),
		contentFormat: text('content_format').notNull(),
		images: jsonb('images').$type<unknown[]>(),
		meta: jsonb('meta').$type<NotesMeta | null>(),
		isPublished: boolean('is_published').notNull().default(true),
		password: text('password'),
		publicAt: timestamp('public_at', { withTimezone: true }),
		mood: text('mood'),
		weather: text('weather'),
		bookmark: boolean('bookmark').notNull().default(false),
		coordinates: jsonb('coordinates').$type<{
			latitude: number;
			longitude: number;
		} | null>(),
		location: text('location'),
		readCount: integer('read_count').notNull().default(0),
		likeCount: integer('like_count').notNull().default(0),
		topicId: uuid('topic_id').references(() => topics.id, {
			onDelete: 'set null'
		})
	},
	(table) => [
		check('notes_lang_check', sql`${table.lang} in ('en', 'zh-cn', 'ja')`),
		check(
			'notes_translation_origin_check',
			sql`${table.translationOrigin} in ('human', 'ai', 'machine')`
		),
		// Source rows own the display number; translation rows copy it (§17).
		uniqueIndex('notes_nid_uniq')
			.on(table.nid)
			.where(sql`${table.translatedFromNoteId} is null`),
		uniqueIndex('notes_lang_slug_uniq').on(table.lang, table.slug),
		uniqueIndex('notes_translation_group_lang_uniq').on(table.translationGroup, table.lang),
		// At most one source row per translation group (fail-closed backstop);
		// the at-least-one side stays an application-level check (mirrors posts).
		uniqueIndex('notes_group_source_uniq')
			.on(table.translationGroup)
			.where(sql`${table.translatedFromNoteId} is null`),
		index('notes_translated_from_idx')
			.on(table.translatedFromNoteId)
			.where(sql`${table.translatedFromNoteId} is not null`),
		index('notes_nid_desc_idx').on(table.nid),
		index('notes_updated_at_idx').on(table.updatedAt),
		index('notes_created_at_idx').on(table.createdAt),
		index('notes_topic_id_idx').on(table.topicId),
		index('notes_published_public_created_idx').on(
			table.isPublished,
			table.createdAt.desc(),
			table.publicAt
		)
	]
);
