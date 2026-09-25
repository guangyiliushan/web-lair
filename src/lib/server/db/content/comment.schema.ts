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
	uuid
} from 'drizzle-orm/pg-core';
import { user } from '../auth.schema';
import { notes } from './note.schema';
import { pages } from './page.schema';
import { posts } from './post.schema';

/**
 * Comment threads with an exclusive-arc target (ledger §9.5/§11-A2): exactly
 * one of post_id / note_id / page_id is set, enforced by CHECK
 * (num_nonnulls(...) = 1) instead of the old ref_type/ref_id pair.
 *
 * Two axes are kept separate on purpose (ledger §4.16): `state` is the
 * moderation decision (pending/approved/rejected) while `is_deleted` /
 * `deleted_at` express removal.
 *
 * Types (P1): the arc columns are uuid like their targets; `reader_id` /
 * `reviewed_by` point at the auth tables and therefore remain text
 * permanently (§9.6 exception).
 */
export const comments = pgTable(
	'comments',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }),
		noteId: uuid('note_id').references(() => notes.id, { onDelete: 'cascade' }),
		pageId: uuid('page_id').references(() => pages.id, { onDelete: 'cascade' }),
		author: text('author'),
		mail: text('mail'),
		url: text('url'),
		text: text('text').notNull(),
		state: text('state').notNull().default('pending'),
		reviewedBy: text('reviewed_by').references(() => user.id, { onDelete: 'set null' }),
		reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
		parentCommentId: uuid('parent_comment_id').references((): AnyPgColumn => comments.id, {
			onDelete: 'cascade'
		}),
		rootCommentId: uuid('root_comment_id').references((): AnyPgColumn => comments.id, {
			onDelete: 'cascade'
		}),
		replyCount: integer('reply_count').notNull().default(0),
		latestReplyAt: timestamp('latest_reply_at', { withTimezone: true }),
		isDeleted: boolean('is_deleted').notNull().default(false),
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		ip: text('ip'),
		agent: text('agent'),
		pin: boolean('pin').notNull().default(false),
		location: text('location'),
		isWhisper: boolean('is_whisper').notNull().default(false),
		avatar: text('avatar'),
		authProvider: text('auth_provider'),
		meta: jsonb('meta').$type<Record<string, unknown> | null>(),
		readerId: text('reader_id').references(() => user.id, { onDelete: 'set null' }),
		editedAt: timestamp('edited_at', { withTimezone: true }),
		anchor: jsonb('anchor').$type<Record<string, unknown> | null>(),
		isOwnerReply: boolean('is_owner_reply').notNull().default(false),
		countryCode: text('country_code')
	},
	(table) => [
		check(
			'comments_ref_exclusive_check',
			sql`num_nonnulls(${table.postId}, ${table.noteId}, ${table.pageId}) = 1`
		),
		check('comments_state_check', sql`${table.state} in ('pending', 'approved', 'rejected')`),
		// The two removal markers must agree (mirrors user_profiles.deleted_at).
		check(
			'comments_deleted_at_check',
			sql`(${table.isDeleted}) = (${table.deletedAt} is not null)`
		),
		index('comments_post_thread_idx')
			.on(table.postId, table.parentCommentId, table.pin, table.createdAt)
			.where(sql`${table.postId} is not null`),
		index('comments_root_idx').on(table.rootCommentId, table.createdAt),
		index('comments_reader_idx').on(table.readerId),
		// Self-referential FK cascade needs a leading index on the child column (§11-A2).
		index('comments_parent_idx')
			.on(table.parentCommentId)
			.where(sql`${table.parentCommentId} is not null`),
		// Every CASCADE / SET NULL FK on this table gets a partial leading index
		// (§11-A2): deleting a note/page or a user must not scan the table.
		index('comments_note_idx')
			.on(table.noteId)
			.where(sql`${table.noteId} is not null`),
		index('comments_page_idx')
			.on(table.pageId)
			.where(sql`${table.pageId} is not null`),
		index('comments_reviewed_by_idx')
			.on(table.reviewedBy)
			.where(sql`${table.reviewedBy} is not null`),
		// Review queue lists only the pending state - partial index (§9.5).
		index('comments_review_idx')
			.on(table.state, table.createdAt)
			.where(sql`${table.state} = 'pending'`)
	]
);
