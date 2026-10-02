import { and, asc, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '$lib/server/db';
import { comments, notes, posts } from '$lib/server/db/content';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { isAdminRole } from '$lib/server/auth/owner';
import { getCache } from '$lib/server/cache';
import { rateLimit, type CacheStore } from '$lib/server/cache/store';
import { isUuid } from '$lib/utils/uuid';
import {
	COMMENT_MAX_LENGTH,
	type CommentTargetType,
	type ThreadReply,
	type ThreadRoot,
	type ThreadsPage
} from '$lib/components/comments/types';
import { visibleNoteCondition } from './note-visibility';
import { visiblePostCondition } from './post-visibility';

/**
 * Public comment threads (comment P3a, ledger §27 / spec §10): article-level
 * comments on posts - anchored (segment) comments are P3b. The read side is
 * target-shaped so the notes/pages mounts can reuse it; the write side only
 * admits posts until those mounts land (fail-closed, see `submitComment`).
 *
 * Visibility (flipped §19.6): approved rows are public, a signed-in reader
 * additionally sees their own pending rows ("审核中"), rejected rows never
 * render. Deleted rows stay in the row set - the assembly turns an approved
 * root with visible replies into a floor-keeping placeholder and drops
 * everything else. Deleted REPLIES are excluded in SQL (the assembly drops
 * them unconditionally, so the row budget is not spent on invisible rows).
 */

/** Read caps (grill Q6): the root page doubles as the future "load more" unit. */
export const THREAD_ROOT_LIMIT = 200;
export const THREAD_REPLY_LIMIT = 500;

/** Per-reader submission window (spec §1: 60s <= 2; grill Q1/Q2). */
export const COMMENT_RATE_LIMIT = { limit: 2, windowSeconds: 60 } as const;

/** Text bounds (spec §1): normalise first, then count code points. */
export const COMMENT_MIN_LENGTH = 1;

function targetColumn(targetType: CommentTargetType): PgColumn {
	switch (targetType) {
		case 'post':
			return comments.postId;
		case 'note':
			return comments.noteId;
		case 'page':
			return comments.pageId;
	}
}

/** Column subset every thread query shares. */
const commentColumns = {
	id: comments.id,
	text: comments.text,
	author: comments.author,
	avatar: comments.avatar,
	state: comments.state,
	isDeleted: comments.isDeleted,
	isOwnerReply: comments.isOwnerReply,
	pin: comments.pin,
	createdAt: comments.createdAt,
	parentCommentId: comments.parentCommentId,
	rootCommentId: comments.rootCommentId
};

export interface CommentRow {
	id: string;
	text: string;
	author: string | null;
	avatar: string | null;
	state: string;
	isDeleted: boolean;
	isOwnerReply: boolean;
	pin: boolean;
	createdAt: Date;
	parentCommentId: string | null;
	rootCommentId: string | null;
}

/**
 * Row visibility for one target and viewer. Deleted rows deliberately pass:
 * placeholder-vs-drop is an assembly decision, not a query one.
 */
export function visibleCommentCondition(
	targetType: CommentTargetType,
	targetId: string,
	viewerId: string | null
): SQL<unknown> {
	const visibility = viewerId
		? or(
				eq(comments.state, 'approved'),
				and(eq(comments.state, 'pending'), eq(comments.readerId, viewerId))
			)
		: eq(comments.state, 'approved');
	// `and()`/`or()` widen to SQL | undefined only for dynamic operand lists;
	// this condition always has fixed operands.
	return and(eq(targetColumn(targetType), targetId), visibility) as SQL<unknown>;
}

export interface LoadThreadsInput {
	targetType: CommentTargetType;
	targetId: string;
	/** Signed-in reader id; null for guests. */
	viewerId: string | null;
}

/**
 * Two-phase read (grill Q6): roots first - they are the list/pagination unit -
 * then the replies that belong to the fetched roots, so replies can never be
 * orphaned by a row budget shared with the roots list. Each phase fetches one
 * extra row as a truncation probe (a full page without an extra row means the
 * list is genuinely capped).
 */
export async function loadThreads(input: LoadThreadsInput): Promise<ThreadsPage> {
	const condition = visibleCommentCondition(input.targetType, input.targetId, input.viewerId);

	const rootRowsFetched = await db
		.select(commentColumns)
		.from(comments)
		.where(and(condition, isNull(comments.parentCommentId)))
		.orderBy(desc(comments.pin), asc(comments.createdAt))
		.limit(THREAD_ROOT_LIMIT + 1);
	const rootsTruncated = rootRowsFetched.length > THREAD_ROOT_LIMIT;
	const rootRows = rootsTruncated ? rootRowsFetched.slice(0, THREAD_ROOT_LIMIT) : rootRowsFetched;

	const rootIds = rootRows.map((row) => row.id);
	let replyRows: CommentRow[] = [];
	let repliesTruncated = false;
	if (rootIds.length > 0) {
		const replyRowsFetched = await db
			.select(commentColumns)
			.from(comments)
			.where(
				and(condition, inArray(comments.rootCommentId, rootIds), eq(comments.isDeleted, false))
			)
			.orderBy(asc(comments.createdAt))
			.limit(THREAD_REPLY_LIMIT + 1);
		repliesTruncated = replyRowsFetched.length > THREAD_REPLY_LIMIT;
		replyRows = repliesTruncated ? replyRowsFetched.slice(0, THREAD_REPLY_LIMIT) : replyRowsFetched;
	}

	return assembleThreads(rootRows, replyRows, {
		truncated: rootsTruncated || repliesTruncated
	});
}

/**
 * Pure assembly (exported for tests): keeps the query order (roots already
 * pinned-first) and applies the deletion rules of spec §7.
 */
export function assembleThreads(
	rootRows: CommentRow[],
	replyRows: CommentRow[],
	options: { truncated?: boolean } = {}
): ThreadsPage {
	const repliesByRoot = new Map<string, CommentRow[]>();
	for (const row of replyRows) {
		// A deleted reply leaves no trace; replies without a root pointer are
		// not part of the two-level model and are dropped defensively.
		if (row.isDeleted || !row.rootCommentId) continue;
		const siblings = repliesByRoot.get(row.rootCommentId);
		if (siblings) siblings.push(row);
		else repliesByRoot.set(row.rootCommentId, [row]);
	}

	const roots: ThreadRoot[] = [];
	for (const row of rootRows) {
		const visibleReplies = repliesByRoot.get(row.id) ?? [];
		// A deleted root keeps the floor only while visible replies remain;
		// the author and text are withheld entirely (spec §7).
		const keepAsPlaceholder =
			row.isDeleted && row.state === 'approved' && visibleReplies.length > 0;
		if (row.isDeleted && !keepAsPlaceholder) continue;

		// The "回复 @作者" chip resolves inside one root subtree only (a reply's
		// parent is the root or a sibling reply) and never dangles: a hidden or
		// deleted parent yields null.
		const authorById = new Map<string, string | null>();
		for (const reply of visibleReplies) authorById.set(reply.id, reply.author);
		const replies: ThreadReply[] = visibleReplies.map((reply) => ({
			id: reply.id,
			text: reply.text,
			author: reply.author,
			avatar: reply.avatar,
			isOwner: reply.isOwnerReply,
			isPending: reply.state === 'pending',
			createdAt: reply.createdAt,
			replyToAuthor:
				reply.parentCommentId && reply.parentCommentId !== reply.rootCommentId
					? (authorById.get(reply.parentCommentId) ?? null)
					: null
		}));

		roots.push({
			id: row.id,
			text: row.isDeleted ? '' : row.text,
			author: row.isDeleted ? null : row.author,
			avatar: row.isDeleted ? null : row.avatar,
			isOwner: row.isDeleted ? false : row.isOwnerReply,
			isPending: row.isDeleted ? false : row.state === 'pending',
			createdAt: row.createdAt,
			pin: row.pin,
			isDeleted: row.isDeleted,
			replies
		});
	}

	let visibleCount = 0;
	for (const root of roots) visibleCount += 1 + root.replies.length;

	return { roots, visibleCount, truncated: options.truncated ?? false };
}

/* ── Write path ─────────────────────────────────────────────────────────── */

/**
 * Format / zero-width / line-separator characters stripped before validation
 * and storage (security review): an "invisible-only" comment must not pass the
 * empty gate, and bidi controls must not survive into snapshots. ZWJ/ZWNJ are
 * deliberately kept - they are load-bearing inside emoji sequences and some
 * scripts.
 */
const FORMAT_CHARS =
	/[\u00ad\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

export function normalizeCommentText(raw: string): string {
	return raw.replace(FORMAT_CHARS, '').trim();
}

// \p{Cc} = C0/C1 controls; plus the bidi overrides and shortcut marks.
const AUTHOR_CONTROLS = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
export const COMMENT_AUTHOR_MAX = 64;

export function normalizeCommentAuthor(raw: string): string {
	const cleaned = raw.replace(AUTHOR_CONTROLS, '').trim();
	return cleaned.slice(0, COMMENT_AUTHOR_MAX) || 'Reader';
}

export const COMMENT_AVATAR_MAX = 512;

/** Snapshot avatar whitelist: http(s) only, capped (security review). */
export function normalizeCommentAvatar(raw: string | null | undefined): string | null {
	const value = raw?.trim() ?? '';
	if (value.length === 0 || value.length > COMMENT_AVATAR_MAX) return null;
	return /^https?:\/\//i.test(value) ? value : null;
}

/**
 * Resolve a visible post id from a language + slug pair - the single home of
 * the write-path target predicate (route actions resolve through it, and
 * `submitComment` re-validates the id against the same condition).
 */
export async function resolveCommentPostTarget(
	lang: string,
	slug: string,
	now: Date = new Date()
): Promise<string | null> {
	const [row] = await db
		.select({ id: posts.id })
		.from(posts)
		.where(and(eq(posts.lang, lang), eq(posts.slug, slug), visiblePostCondition(now)))
		.limit(1);
	return row?.id ?? null;
}

/**
 * Resolve a commentable note id from a language + slug pair. Password-gated
 * rows are never commentable (fail-closed): comment text must not attach to
 * a diary whose body sits behind a gate, even while an unlock cookie exists.
 */
export async function resolveCommentNoteTarget(
	lang: string,
	slug: string,
	now: Date = new Date()
): Promise<string | null> {
	const [row] = await db
		.select({ id: notes.id })
		.from(notes)
		.where(
			and(
				eq(notes.lang, lang),
				eq(notes.slug, slug),
				visibleNoteCondition(now),
				isNull(notes.passwordHash)
			)
		)
		.limit(1);
	return row?.id ?? null;
}

export interface SubmitCommentInput {
	targetType: CommentTargetType;
	/** Target row id, already resolved from the URL by the caller. */
	targetId: string;
	/** URL language; part of the authoritative target re-check. */
	lang: string;
	/** Root comment id when this submission is a reply. */
	parentId?: string | null;
	text: string;
	/** Signed-in reader; the route resolves the display snapshot. */
	user: { id: string; role?: unknown; emailVerified?: boolean };
	author: string;
	avatar: string | null;
	/** Test seam: cache store override (defaults to the process-wide store). */
	cache?: CacheStore;
	/** Test seam: clock. */
	now?: Date;
}

export type SubmitCommentResult =
	| { kind: 'created'; id: string; state: 'pending' | 'approved' }
	| { kind: 'throttled'; windowSeconds: number }
	| { kind: 'unverified' }
	| { kind: 'empty' }
	| { kind: 'too-long'; max: number }
	| { kind: 'target-unavailable' }
	| { kind: 'parent-unavailable' }
	| { kind: 'unsupported-target' };

export async function submitComment(input: SubmitCommentInput): Promise<SubmitCommentResult> {
	const now = input.now ?? new Date();

	// Defense in depth (spec §1 "已验证读者"): the route checks too, but this
	// service is the authoritative layer every future mount will call - it
	// fails closed when the caller forgets the gate.
	if (input.user.emailVerified !== true) return { kind: 'unverified' };

	const text = normalizeCommentText(input.text);
	const length = [...text].length;
	if (length < COMMENT_MIN_LENGTH) return { kind: 'empty' };
	if (length > COMMENT_MAX_LENGTH) return { kind: 'too-long', max: COMMENT_MAX_LENGTH };

	// Notes validate here since N1; pages arrive with pages P1b and stay
	// fail-closed until then (spec §10 - the mount batches extend this).
	if (input.targetType !== 'post' && input.targetType !== 'note')
		return { kind: 'unsupported-target' };

	if (!isUuid(input.targetId)) return { kind: 'target-unavailable' };
	if (input.targetType === 'post') {
		const [target] = await db
			.select({ id: posts.id, allowComment: posts.allowComment })
			.from(posts)
			.where(
				and(eq(posts.id, input.targetId), eq(posts.lang, input.lang), visiblePostCondition(now))
			)
			.limit(1);
		if (!target || !target.allowComment) return { kind: 'target-unavailable' };
	} else {
		// Password-gated notes are never commentable, fail-closed: comment
		// text must not attach to a diary whose body sits behind a gate.
		const [target] = await db
			.select({ id: notes.id, allowComment: notes.allowComment })
			.from(notes)
			.where(
				and(
					eq(notes.id, input.targetId),
					eq(notes.lang, input.lang),
					visibleNoteCondition(now),
					isNull(notes.passwordHash)
				)
			)
			.limit(1);
		if (!target || !target.allowComment) return { kind: 'target-unavailable' };
	}

	let rootCommentId: string | null = null;
	let parentCommentId: string | null = null;
	if (input.parentId) {
		if (!isUuid(input.parentId)) return { kind: 'parent-unavailable' };
		const [parent] = await db
			.select({
				id: comments.id,
				postId: comments.postId,
				noteId: comments.noteId,
				state: comments.state,
				isDeleted: comments.isDeleted,
				rootCommentId: comments.rootCommentId
			})
			.from(comments)
			.where(eq(comments.id, input.parentId))
			.limit(1);
		// A reply needs an approved, undeleted parent on the same target - the
		// same rows the public list shows (spec §6/§8).
		const parentTargetId =
			input.targetType === 'post' ? (parent?.postId ?? null) : (parent?.noteId ?? null);
		if (
			!parent ||
			parentTargetId !== input.targetId ||
			parent.state !== 'approved' ||
			parent.isDeleted
		) {
			return { kind: 'parent-unavailable' };
		}
		parentCommentId = parent.id;
		rootCommentId = parent.rootCommentId ?? parent.id;
	}

	// Owner/admin posts skip the window (WordPress core exempts moderators);
	// everyone else shares one cross-target window per reader (grill Q1/Q2).
	// The window is charged only AFTER validation succeeded, so rejected
	// submissions do not eat the reader's budget (review fix).
	const autoApprove = isAdminRole(input.user.role);
	if (!autoApprove) {
		const rate = await rateLimit(
			input.cache ?? getCache(),
			`limits:comment:${input.user.id}`,
			COMMENT_RATE_LIMIT.limit,
			COMMENT_RATE_LIMIT.windowSeconds
		);
		if (!rate.allowed) {
			return { kind: 'throttled', windowSeconds: COMMENT_RATE_LIMIT.windowSeconds };
		}
		if (rate.count === 0) {
			// count === 0 with allowed=true is the rateLimit() fail-open
			// signature (the store threw): deliberate per T14, but it must
			// never happen silently (security review).
			console.warn('[comments] rate limiter store unavailable; failing open');
		}
	}

	// Policy: ip/agent/location/country_code are never collected (spec §1);
	// the display snapshot is sanitised and frozen at write time.
	try {
		const [created] =
			input.targetType === 'post'
				? await db
						.insert(comments)
						.values({
							postId: input.targetId,
							readerId: input.user.id,
							author: normalizeCommentAuthor(input.author),
							avatar: normalizeCommentAvatar(input.avatar),
							text,
							state: autoApprove ? 'approved' : 'pending',
							isOwnerReply: autoApprove,
							parentCommentId,
							rootCommentId,
							reviewedBy: autoApprove ? input.user.id : null,
							reviewedAt: autoApprove ? now : null
						})
						.returning({ id: comments.id, state: comments.state })
				: await db
						.insert(comments)
						.values({
							noteId: input.targetId,
							readerId: input.user.id,
							author: normalizeCommentAuthor(input.author),
							avatar: normalizeCommentAvatar(input.avatar),
							text,
							state: autoApprove ? 'approved' : 'pending',
							isOwnerReply: autoApprove,
							parentCommentId,
							rootCommentId,
							reviewedBy: autoApprove ? input.user.id : null,
							reviewedAt: autoApprove ? now : null
						})
						.returning({ id: comments.id, state: comments.state });
		return { kind: 'created', id: created.id, state: created.state as 'pending' | 'approved' };
	} catch (caught) {
		// The target or parent row was hard-deleted between validation and
		// insert (FK violation): surface the same unavailable outcome instead
		// of an unhandled 500 (database review).
		if (pgErrorCode(caught) === '23503') return { kind: 'target-unavailable' };
		throw caught;
	}
}
