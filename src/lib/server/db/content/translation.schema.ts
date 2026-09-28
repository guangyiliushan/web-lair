import { sql } from 'drizzle-orm';
import {
	check,
	index,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { user } from '../auth.schema';
import { notes } from './note.schema';
import { posts } from './post.schema';

/**
 * Translation workbench (AI-1 patch, ledger §14.3; post/note dual arc added
 * by the micro-content line §17): one row per generation attempt for a post
 * OR a note source. `accepted` = written into the target row; `discarded` =
 * kept for the record (unless the source group is deleted - source FKs
 * cascade). At most one in-flight draft per (source, target lang) - the
 * unique is split per arc because exactly one source column is set, and it
 * is scoped to `status = 'draft'` so a discard does not block
 * re-translation. Targets use SET NULL, so an accepted row can outlive its
 * target pointer (pending: accepted => target non-empty, ledger §17).
 */
export const translations = pgTable(
	'translations',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
		sourcePostId: uuid('source_post_id').references(() => posts.id, { onDelete: 'cascade' }),
		sourceNoteId: uuid('source_note_id').references(() => notes.id, { onDelete: 'cascade' }),
		targetLang: text('target_lang').notNull(),
		title: text('title').notNull(),
		content: text('content'),
		summary: text('summary'),
		contentFormat: text('content_format').notNull().default('markdown'),
		origin: text('origin').notNull(),
		model: text('model'),
		sourceHash: text('source_hash'),
		status: text('status').notNull().default('draft'),
		score: numeric('score'),
		reviewedBy: text('reviewed_by').references(() => user.id, { onDelete: 'set null' }),
		reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
		targetPostId: uuid('target_post_id').references(() => posts.id, { onDelete: 'set null' }),
		targetNoteId: uuid('target_note_id').references(() => notes.id, { onDelete: 'set null' }),
		error: text('error')
	},
	(table) => [
		// Exclusive source arc: exactly one of post / note (§17 C1); at most
		// one target (empty until acceptance). Cross-arc rows (a note source
		// with a post target) are prevented at the application layer - a
		// DB-level implication CHECK is registered as pending (ledger §17).
		check(
			'translations_source_arc_check',
			sql`num_nonnulls(${table.sourcePostId}, ${table.sourceNoteId}) = 1`
		),
		check(
			'translations_target_arc_check',
			sql`num_nonnulls(${table.targetPostId}, ${table.targetNoteId}) <= 1`
		),
		check('translations_target_lang_check', sql`${table.targetLang} in ('en', 'zh-cn', 'ja')`),
		check('translations_origin_check', sql`${table.origin} in ('human', 'ai', 'machine')`),
		check('translations_status_check', sql`${table.status} in ('draft', 'accepted', 'discarded')`),
		uniqueIndex('translations_draft_post_uniq')
			.on(table.sourcePostId, table.targetLang)
			.where(sql`${table.status} = 'draft' and ${table.sourcePostId} is not null`),
		uniqueIndex('translations_draft_note_uniq')
			.on(table.sourceNoteId, table.targetLang)
			.where(sql`${table.status} = 'draft' and ${table.sourceNoteId} is not null`),
		// Partial leading indexes serve the FK referential checks (§11-A2):
		// the arc column is non-null whenever a check runs.
		index('translations_source_post_idx')
			.on(table.sourcePostId)
			.where(sql`${table.sourcePostId} is not null`),
		index('translations_source_note_idx')
			.on(table.sourceNoteId)
			.where(sql`${table.sourceNoteId} is not null`),
		index('translations_target_post_idx')
			.on(table.targetPostId)
			.where(sql`${table.targetPostId} is not null`),
		index('translations_target_note_idx')
			.on(table.targetNoteId)
			.where(sql`${table.targetNoteId} is not null`),
		index('translations_reviewed_by_idx')
			.on(table.reviewedBy)
			.where(sql`${table.reviewedBy} is not null`)
	]
);
