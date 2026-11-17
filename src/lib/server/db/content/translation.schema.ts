import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { user } from '../auth.schema.ts';
import { notes } from './note.schema.ts';
import { posts } from './post.schema.ts';

/** One slice of a chunked translation run (written by the chunked path, Task C). */
export interface TranslationProgressChunk {
	ordinal: number;
	status: 'pending' | 'done' | 'failed';
	text?: string;
	tokens?: number;
	error?: string;
}

/**
 * `translations.progress`: how far a chunked run got. Only a complete,
 * whole-document-validated body may reach `content`; partial chunk text lives
 * here so a run stopped by the run budget or a crash can resume.
 */
export interface TranslationProgress {
	total: number;
	done: number;
	chunks: TranslationProgressChunk[];
	/**
	 * Source hash and chunk size the chunks were cut with. A changed source or
	 * a different chunk budget invalidates them: resuming stale chunks would
	 * mix two documents.
	 */
	sourceHash?: string;
	maxChars?: number;
	/**
	 * The body text received so far while a run is generating, with its
	 * placeholders already restored. The job writes it so the drawer can
	 * preview the model's output before the row completes; failed and parked
	 * runs clear it, while finished chunks stay for the next tick.
	 */
	partial?: string;
	/**
	 * Glossary terms the prompt asked for but the finished body does not
	 * contain. Advisory: the candidate is still usable, the drawer just shows
	 * which terms to look at (and which glossary row might be wrong).
	 */
	glossaryMisses?: { term: string; expected: string }[];
}

/**
 * Translation workbench: one row per generation attempt for a post OR a
 * note source. `accepted` = written into the target row; `discarded` =
 * kept for the record (unless the source group is deleted - source FKs
 * cascade). At most one in-flight draft per (source, target lang) - the
 * unique is split per arc because exactly one source column is set, and it
 * is scoped to `status = 'draft'` so a discard does not block
 * re-translation. Targets use SET NULL, so an accepted row can outlive its
 * target pointer (pending: accepted => target non-empty).
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
		/**
		 * Who asked for this generation. Null means "not a person": the
		 * auto-translate job queues rows on its own. Kept separate from
		 * `reviewed_by` because requesting and reviewing are different acts, and
		 * it is what lets `ai_usage.actor_id` answer "who spent this".
		 */
		requestedBy: text('requested_by').references(() => user.id, { onDelete: 'set null' }),
		targetPostId: uuid('target_post_id').references(() => posts.id, { onDelete: 'set null' }),
		targetNoteId: uuid('target_note_id').references(() => notes.id, { onDelete: 'set null' }),
		error: text('error'),
		/**
		 * The operator asked this generation to replace the existing target
		 * draft (a copy prefill or an earlier AI body). Without the flag,
		 * accept refuses to clobber a target that no AI accept has written to
		 * yet, so a failed generation cannot silently destroy human work.
		 */
		overwriteTarget: boolean('overwrite_target').notNull().default(false),
		/**
		 * Lease written by the single-statement claim (`ai/translation-lease.ts`).
		 * `runs` counts claims (a crash loop guard: 20 and the row is no longer
		 * claimed); `attempt` counts failed generation attempts (3 and the row is
		 * abandoned). They are separate on purpose: a worker killed after a claim
		 * must not consume a failure, and a retryable error must not look like a
		 * crash.
		 */
		runs: integer('runs').notNull().default(0),
		attempt: integer('attempt').notNull().default(0),
		startedAt: timestamp('started_at', { withTimezone: true }),
		/** Refreshed every 5s while a worker runs; stale after 90s means reclaimable. */
		heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
		/**
		 * Coarse phase for the drawer: 'body' | 'title' | 'summary' | 'waiting'.
		 * Open text (no CHECK): a new phase must not need a migration.
		 */
		stage: text('stage'),
		/**
		 * Why a row is parked at `stage = 'waiting'`. The sanitized provider
		 * message (a rate limit, a network outage, a paused budget), so the
		 * drawer can say why instead of painting a bare "pending".
		 */
		waitingReason: text('waiting_reason'),
		cancelRequested: boolean('cancel_requested').notNull().default(false),
		progress: jsonb('progress').$type<TranslationProgress>()
	},
	(table) => [
		// Exclusive source arc: exactly one of post / note; at most one target
		// (empty until acceptance). Cross-arc rows (a note source with a post
		// target) are prevented at the application layer - a DB-level
		// implication CHECK is registered as pending.
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
		// Partial leading indexes serve the FK referential checks: the arc
		// column is non-null whenever a check runs.
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
			.where(sql`${table.reviewedBy} is not null`),
		index('translations_requested_by_idx')
			.on(table.requestedBy)
			.where(sql`${table.requestedBy} is not null`)
	]
);
