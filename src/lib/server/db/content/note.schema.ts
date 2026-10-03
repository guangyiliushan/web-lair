import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	smallint,
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
	/** Fine-grained emotion tokens (Apple HealthKit label set; i18n-rendered, N1). */
	emotions?: string[];
	[key: string]: unknown;
}

/** Notes status machine (notes plan v0.3 §7.1). */
export const NOTES_STATUSES = ['draft', 'private', 'scheduled', 'published', 'trash'] as const;

/** Coarse daily valence (notes plan v0.3 §7.1; the Apple 5–7 level family). */
export const NOTE_MOODS = ['very_bad', 'bad', 'neutral', 'good', 'very_good'] as const;

/**
 * Notes are multi-language like posts (micro-content line §17): `lang` +
 * `translation_group` + `(lang, slug)` unique; translations are separate rows
 * sharing the source `nid` and pointing at the group source via
 * `translated_from_note_id`. Deleting a group source is a group-level flow
 * (ledger §14.4/§17): while translations exist the DB refuses the delete
 * outright (the SET NULL pass would collide with notes_group_source_uniq),
 * so group cleanup happens in application code. v0.3 reshaped the legacy
 * diary columns into the status machine + metadata set (title/slug NOT NULL;
 * mood/weather/coords CHECKs; encryption via `password_hash`).
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
		title: text('title').notNull(),
		slug: text('slug').notNull(),
		status: text('status').notNull().default('draft'),
		content: text('content'),
		contentFormat: text('content_format').notNull().default('markdown'),
		meta: jsonb('meta').$type<NotesMeta | null>(),
		// Write paths must pass `isPgAcceptableTimeZone` (server/pg-timezone):
		// Intl alone accepts names PostgreSQL rejects (e.g. 'Japan').
		tz: text('tz'),
		publishedAt: timestamp('published_at', { withTimezone: true }),
		pinAt: timestamp('pin_at', { withTimezone: true }),
		mood: text('mood'),
		weatherCode: smallint('weather_code'),
		temperatureC: numeric('temperature_c', { precision: 4, scale: 1 }),
		coordinates: jsonb('coordinates').$type<{
			latitude: number;
			longitude: number;
		} | null>(),
		location: text('location'),
		passwordHash: text('password_hash'),
		allowComment: boolean('allow_comment').notNull().default(true),
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
		check(
			'notes_status_check',
			sql`${table.status} in ('draft', 'private', 'scheduled', 'published', 'trash')`
		),
		check('notes_content_format_check', sql`${table.contentFormat} in ('markdown')`),
		check(
			'notes_mood_check',
			sql`${table.mood} is null or ${table.mood} in ('very_bad', 'bad', 'neutral', 'good', 'very_good')`
		),
		check(
			'notes_weather_code_check',
			sql`${table.weatherCode} is null or (${table.weatherCode} between 0 and 99)`
		),
		check(
			'notes_temperature_c_check',
			sql`${table.temperatureC} is null or (${table.temperatureC} between -99.9 and 99.9)`
		),
		// CASE form: PostgreSQL does not guarantee AND evaluation order, so the
		// casts must sit inside a CASE that only runs on jsonb numbers.
		check(
			'notes_coordinates_check',
			sql`${table.coordinates} is null or (jsonb_typeof(${table.coordinates}) = 'object' and case when jsonb_typeof(${table.coordinates} -> 'latitude') = 'number' and jsonb_typeof(${table.coordinates} -> 'longitude') = 'number' then ((${table.coordinates} ->> 'latitude')::numeric between -90 and 90 and (${table.coordinates} ->> 'longitude')::numeric between -180 and 180) else false end)`
		),
		// Source rows own the display number; translation rows copy it (§17).
		uniqueIndex('notes_nid_uniq')
			.on(table.nid)
			.where(sql`${table.translatedFromNoteId} is null`),
		uniqueIndex('notes_lang_slug_uniq').on(table.lang, table.slug),
		uniqueIndex('notes_translation_group_lang_uniq').on(table.translationGroup, table.lang),
		// At most one source row per translation group (fail-closed backstop); the
		// at-least-one side stays an application-level check (mirrors posts).
		uniqueIndex('notes_group_source_uniq')
			.on(table.translationGroup)
			.where(sql`${table.translatedFromNoteId} is null`),
		index('notes_translated_from_idx')
			.on(table.translatedFromNoteId)
			.where(sql`${table.translatedFromNoteId} is not null`),
		// §11-A1 shape: language-filtered front lists; topic_id leads the second
		// index, which also covers the topic_id FK leading-index rule (§11-A2).
		index('notes_status_pin_published_idx').on(
			table.status,
			table.pinAt.desc().nullsLast(),
			table.publishedAt.desc()
		),
		index('notes_topic_status_published_idx').on(
			table.topicId,
			table.status,
			table.pinAt.desc().nullsLast(),
			table.publishedAt.desc()
		),
		index('notes_updated_at_idx').on(table.updatedAt),
		index('notes_created_at_idx').on(table.createdAt)
	]
);
