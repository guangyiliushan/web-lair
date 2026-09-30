import { and, asc, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '$lib/server/db';
import { comments, posts } from '$lib/server/db/content';
import { isAdminRole } from '$lib/server/auth/owner';
import { rateLimit, type CacheStore } from '$lib/server/cache/store';
import { isUuid } from '$lib/utils/uuid';
import type {
	CommentTargetType,
	ThreadReply,
	ThreadRoot,
	ThreadsPage
} from '$lib/components/comments/types';
import { visiblePostCondition } from './post-visibility';

export type {
	CommentTargetType,
	CommentView,
	ThreadReply,
	ThreadRoot,
	ThreadsPage
} from '$lib/components/comments/types';

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
 * everything else.
 */

/** Read caps (grill Q6): the root page doubles as the future "load more" unit. */
export const THREAD_ROOT_LIMIT = 200;
export const THREAD_REPLY_LIMIT = 500;

/** Per-reader submission window (spec §1: 60s <= 2; grill Q1/Q2). */
export const COMMENT_RATE_LIMIT = { limit: 2, windowSeconds: 60 } as const;

/** Text bounds (spec §1): trim first, then count code points. */
export const COMMENT_MIN_LENGTH = 1;
export const COMMENT_MAX_LENGTH = 2000;

export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
	readerId: comments.readerId,
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
	readerId: string | null;
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
 * orphaned by a row budget shared with the roots list.
 */
export async function loadThreads(
	input: LoadThreadsInput,
	executor: DbExecutor = db
): Promise<ThreadsPage> {
	const condition = visibleCommentCondition(input.targetType, input.targetId, input.viewerId);

	const rootRows = await executor
		.select(commentColumns)
		.from(comments)
		.where(and(condition, isNull(comments.parentCommentId)))
		.orderBy(desc(comments.pin), asc(comments.createdAt))
		.limit(THREAD_ROOT_LIMIT);

	const rootIds = rootRows.map((row) => row.id);
	const replyRows =
		rootIds.length === 0
			? []
			: await executor
					.select(commentColumns)
					.from(comments)
					.where(and(condition, inArray(comments.rootCommentId, rootIds)))
					.orderBy(asc(comments.createdAt))
					.limit(THREAD_REPLY_LIMIT);

	return assembleThreads(rootRows, replyRows, {
		truncated: rootRows.length === THREAD_ROOT_LIMIT || replyRows.length === THREAD_REPLY_LIMIT
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
			replyCount: replies.length,
			replies
		});
	}

	let visibleCount = 0;
	for (const root of roots) visibleCount += 1 + root.replies.length;

	return { roots, visibleCount, truncated: options.truncated ?? false };
}

/* ── Write path ─────────────────────────────────────────────────────────── */

export interface SubmitCommentInput {
	targetType: CommentTargetType;
	targetId: string;
	/** Root comment id when this submission is a reply. */
	parentId?: string | null;
	text: string;
	/** Signed-in reader; the route resolves the display-name snapshot. */
	user: { id: string; role?: unknown };
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
	| { kind: 'empty' }
	| { kind: 'too-long'; max: number }
	| { kind: 'target-unavailable' }
	| { kind: 'parent-unavailable' }
	| { kind: 'unsupported-target' };

export async function submitComment(
	input: SubmitCommentInput,
	executor: DbExecutor = db
): Promise<SubmitCommentResult> {
	const now = input.now ?? new Date();
	const text = input.text.trim();
	const length = [...text].length;
	if (length < COMMENT_MIN_LENGTH) return { kind: 'empty' };
	if (length > COMMENT_MAX_LENGTH) return { kind: 'too-long', max: COMMENT_MAX_LENGTH };

	// Notes/pages mounts arrive with N1 / pages P1b; until then only posts
	// validate here, fail-closed (spec §10 - the mount batches extend this).
	if (input.targetType !== 'post') return { kind: 'unsupported-target' };

	// Owner/admin posts skip the window (WordPress core exempts moderators);
	// everyone else shares one cross-target window per reader (grill Q1/Q2).
	const autoApprove = isAdminRole(input.user.role);
	if (!autoApprove) {
		const store = input.cache ?? (await import('$lib/server/cache')).getCache();
		const rate = await rateLimit(
			store,
			`limits:comment:${input.user.id}`,
			COMMENT_RATE_LIMIT.limit,
			COMMENT_RATE_LIMIT.windowSeconds
		);
		if (!rate.allowed) {
			return { kind: 'throttled', windowSeconds: COMMENT_RATE_LIMIT.windowSeconds };
		}
	}

	if (!isUuid(input.targetId)) return { kind: 'target-unavailable' };
	const [target] = await executor
		.select({ id: posts.id, allowComment: posts.allowComment })
		.from(posts)
		.where(and(eq(posts.id, input.targetId), visiblePostCondition(now)))
		.limit(1);
	if (!target || !target.allowComment) return { kind: 'target-unavailable' };

	let rootCommentId: string | null = null;
	let parentCommentId: string | null = null;
	if (input.parentId) {
		if (!isUuid(input.parentId)) return { kind: 'parent-unavailable' };
		const [parent] = await executor
			.select({
				id: comments.id,
				postId: comments.postId,
				state: comments.state,
				isDeleted: comments.isDeleted,
				rootCommentId: comments.rootCommentId
			})
			.from(comments)
			.where(eq(comments.id, input.parentId))
			.limit(1);
		// A reply needs an approved, undeleted parent on the same target - the
		// same rows the public list shows (spec §6/§8).
		if (
			!parent ||
			parent.postId !== input.targetId ||
			parent.state !== 'approved' ||
			parent.isDeleted
		) {
			return { kind: 'parent-unavailable' };
		}
		parentCommentId = parent.id;
		rootCommentId = parent.rootCommentId ?? parent.id;
	}

	// Policy: ip/agent/location/country_code are never collected (spec §1);
	// the display snapshot is frozen at write time.
	const [created] = await executor
		.insert(comments)
		.values({
			postId: input.targetId,
			readerId: input.user.id,
			author: input.author,
			avatar: input.avatar,
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
}
