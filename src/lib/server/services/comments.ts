import { and, asc, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { comments, notes, pages, posts } from '$lib/server/db/content';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { isAdminRole } from '$lib/server/auth/owner';
import { evaluateCommentModeration, recordModerationEvents } from './comment-moderation';
import { getCache } from '$lib/server/cache';
import { rateLimit, rateLimitStrict, type CacheStore } from '$lib/server/cache/store';
import { getOption } from '$lib/server/config/options-registry';
import { enqueueNotification, type NotificationOutboxDb } from '$lib/server/notifications/outbox';
import { normalizeCountry, normalizeRegion } from '$lib/server/security/geoip';
import { clientAddressKey, ipMatchesCidrs } from '$lib/utils/cidr';
import { locales } from '$lib/paraglide/runtime';
import { isUuid } from '$lib/utils/uuid';
import {
	COMMENT_MAX_LENGTH,
	type CommentAnchorView,
	type CommentTargetType,
	type ThreadReply,
	type ThreadRoot,
	type ThreadsPage
} from '$lib/components/comments/types';
import {
	collectAnchorBlocks,
	commentAnchorSchema,
	parseCommentAnchor,
	parseCommentAnchorDraft,
	resolveAnchor,
	resolveAnchorDraft,
	type AnchorBlock,
	type AnchorMark
} from '$lib/server/comment-anchor';
import {
	quoteDisplay,
	type CommentAnchor,
	type CommentAnchorDraft
} from '$lib/utils/comment-anchor';
import { visibleNoteCondition } from './note-visibility';
import { getPageBySlug, servablePageBody } from './pages';
import { visiblePostCondition } from './post-visibility';

/**
 * Public comment threads: article-level comments on posts / notes / pages - the
 * anchored (segment) variant is documented below. The read side is target-shaped
 * across the three arcs.
 *
 * Visibility: approved rows are public, a signed-in reader
 * additionally sees their own pending rows ("审核中"), rejected rows never
 * render. Deleted rows stay in the row set - the assembly turns an approved
 * root with visible replies into a floor-keeping placeholder and drops
 * everything else. Deleted REPLIES are excluded in SQL (the assembly drops
 * them unconditionally, so the row budget is not spent on invisible rows).
 */

/** Read caps: the root page doubles as the future "load more" unit. */
export const THREAD_ROOT_LIMIT = 200;
export const THREAD_REPLY_LIMIT = 500;

/** Per-reader submission window (60s, at most 2). */
export const COMMENT_RATE_LIMIT = { limit: 2, windowSeconds: 60 } as const;

/**
 * Per-IP submission window: the per-reader window
 * cannot stop one client cycling accounts. Fail-CLOSED (a dead cache answers
 * 503) and keyed on the /64 for IPv6; this is request-time only - the raw
 * address is never stored. 30/10min stays well above a busy shared household
 * while still bounding a flood.
 */
export const COMMENT_IP_RATE_LIMIT = { limit: 30, windowSeconds: 10 * 60 } as const;

/**
 * Segment-anchor validation budget. Anchor submissions
 * render the whole body (Shiki/KaTeX) *before* the comment window is charged,
 * so without this second, coarse limit a verified reader could loop stale
 * anchors and burn CPU with no per-user bound. 10 attempts/min keeps honest
 * stale retries cheap and still bounds the ramp; owner/admin skip it like the
 * main window.
 */
export const ANCHOR_RATE_LIMIT = { limit: 10, windowSeconds: 60 } as const;

/**
 * Rejections are the only visible signal that the client and server block
 * directories drifted. One line per target+reason per minute: enough to spot a
 * systemic break, never one line per stale tab.
 */
const anchorRejectAt = new Map<string, number>();
function warnAnchorRejected(targetType: string, targetId: string, reason: string): void {
	const key = `${targetType}:${targetId}:${reason}`;
	const now = Date.now();
	if (now - (anchorRejectAt.get(key) ?? 0) < 60_000) return;
	if (anchorRejectAt.size > 200) anchorRejectAt.clear();
	anchorRejectAt.set(key, now);
	console.warn('[comments] anchor draft rejected', { targetType, targetId, reason });
}

/** Text bounds: normalise first, then count code points. */
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
	rootCommentId: comments.rootCommentId,
	editedAt: comments.editedAt,
	// Authoring identity stays server-side: the assembly converts it into the
	// boolean `isMine` so the client never receives reader ids.
	readerId: comments.readerId,
	// Stored segment anchor: resolved in the assembly, never serialized raw.
	anchor: comments.anchor,
	// Privacy fields surface only through the `showCountry` opt-in gate.
	// `region_code` is written for retention/audit only; the view model carries
	// the country label, so it is not selected on every thread read.
	countryCode: comments.countryCode,
	meta: comments.meta
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
	editedAt: Date | null;
	readerId: string | null;
	/** Stored jsonb anchor; `unknown` on purpose (Zod decides, not the row type). */
	anchor?: unknown;
	/** Privacy snapshot (never rendered without the per-comment opt-in). */
	countryCode?: string | null;
	meta?: Record<string, unknown> | null;
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
	/** Offer the per-comment country label; default off. */
	showCountry?: boolean;
}

/**
 * Two-phase read: roots first - they are the list/pagination unit -
 * then the replies that belong to the fetched roots, so replies can never be
 * orphaned by a row budget shared with the roots list. Each phase fetches one
 * extra row as a truncation probe (a full page without an extra row means the
 * list is genuinely capped). A soft-deleted root that the assembly will drop
 * still spends its slot (accepted 2026-10-12: the cap is a seatbelt, and the
 * viewer-dependent SQL prefilter costs more than it saves).
 */
export async function loadThreads(input: LoadThreadsInput): Promise<ThreadsPage> {
	const rows = await fetchThreadRows(input);
	return assembleDiscussion(rows.rootRows, rows.replyRows, {
		truncated: rows.truncated,
		viewerId: input.viewerId,
		showCountry: input.showCountry
	}).threads;
}

export interface LoadDiscussionInput extends LoadThreadsInput {
	/** Block directory of the body being rendered. */
	blocks: AnchorBlock[];
}

/**
 * Segment-aware read: same query, plus anchor resolution against the
 * rendered block directory. The marks are applied to the tree by the caller
 * (`renderDiscussion`); `threads.orphans` holds the roots whose anchor no
 * longer resolves. Anchors never reach the page payload — the view model only
 * carries the display quote and the rendered target id.
 */
export async function loadDiscussion(input: LoadDiscussionInput): Promise<DiscussionRead> {
	const rows = await fetchThreadRows(input);
	return assembleDiscussion(rows.rootRows, rows.replyRows, {
		truncated: rows.truncated,
		viewerId: input.viewerId,
		blocks: input.blocks,
		showCountry: input.showCountry
	});
}

interface ThreadRows {
	rootRows: CommentRow[];
	replyRows: CommentRow[];
	truncated: boolean;
}

async function fetchThreadRows(input: LoadThreadsInput): Promise<ThreadRows> {
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

	return { rootRows, replyRows, truncated: rootsTruncated || repliesTruncated };
}

export interface AssemblyOptions {
	truncated?: boolean;
	viewerId?: string | null;
	/** When present, segment anchors are resolved and marks are produced. */
	blocks?: AnchorBlock[];
	/**
	 * Render the per-comment country label. The row must ALSO carry the
	 * commenter's own opt-in in `meta.showCountry`; region/city never render.
	 */
	showCountry?: boolean;
}

export interface DiscussionRead {
	threads: ThreadsPage;
	/** Marks to apply to the rendered tree; server-side only, never serialized. */
	marks: AnchorMark[];
}

/**
 * Pure assembly (exported for tests): keeps the query order (roots already
 * pinned-first) and applies the deletion rules.
 */
export function assembleThreads(
	rootRows: CommentRow[],
	replyRows: CommentRow[],
	options: AssemblyOptions = {}
): ThreadsPage {
	return assembleDiscussion(rootRows, replyRows, options).threads;
}

/**
 * Assembly + anchor resolution: a root whose stored
 * anchor resolves keeps its main-list slot and gets a quote chip; one whose
 * anchor no longer resolves moves to `orphans` (the folded "original text
 * changed" area with its own count). Marks are emitted for surviving anchored
 * roots only — a deleted floor placeholder keeps its underline, a fully
 * vanished thread does not. Without `blocks` (article-level readers) an
 * anchored row is orphaned: fail-visible beats silently dropping the chip.
 */
export function assembleDiscussion(
	rootRows: CommentRow[],
	replyRows: CommentRow[],
	options: AssemblyOptions = {}
): DiscussionRead {
	const viewerId = options.viewerId ?? null;
	const isMine = (row: CommentRow) => viewerId !== null && row.readerId === viewerId;
	// Country is a two-key decision: the site must opt in AND the
	// commenter must have opted in on their own row. Region/city never render.
	const publicCountry = (row: CommentRow): string | null =>
		options.showCountry && row.meta?.showCountry === true ? (row.countryCode ?? null) : null;
	const repliesByRoot = new Map<string, CommentRow[]>();
	for (const row of replyRows) {
		// A deleted reply leaves no trace; replies without a root pointer are
		// not part of the two-level model and are dropped defensively.
		if (row.isDeleted || !row.rootCommentId) continue;
		const siblings = repliesByRoot.get(row.rootCommentId);
		if (siblings) siblings.push(row);
		else repliesByRoot.set(row.rootCommentId, [row]);
	}

	const anchorOf = (
		row: CommentRow
	): { view: CommentAnchorView | null; mark: AnchorMark | null } => {
		const raw = parseCommentAnchor(row.anchor);
		if (!raw) return { view: null, mark: null };
		const view: CommentAnchorView = {
			quote: quoteDisplay(raw.quote.exact),
			orphaned: false,
			targetId: null
		};
		if (!options.blocks) return { view: { ...view, orphaned: true }, mark: null };
		const resolved = resolveAnchor(options.blocks, raw);
		if (!resolved) return { view: { ...view, orphaned: true }, mark: null };
		return {
			view,
			mark: {
				commentId: row.id,
				blockOrd: resolved.block.ord,
				start: resolved.start,
				end: resolved.end,
				pending: row.state === 'pending'
			}
		};
	};

	const roots: ThreadRoot[] = [];
	const orphans: ThreadRoot[] = [];
	const marks: AnchorMark[] = [];
	for (const row of rootRows) {
		const visibleReplies = repliesByRoot.get(row.id) ?? [];
		// A deleted root keeps the floor only while visible replies remain;
		// the author and text are withheld entirely.
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
			isMine: isMine(reply),
			editedAt: reply.editedAt,
			createdAt: reply.createdAt,
			replyToAuthor:
				reply.parentCommentId && reply.parentCommentId !== reply.rootCommentId
					? (authorById.get(reply.parentCommentId) ?? null)
					: null
		}));

		const anchor = anchorOf(row);
		const entry: ThreadRoot = {
			id: row.id,
			text: row.isDeleted ? '' : row.text,
			author: row.isDeleted ? null : row.author,
			avatar: row.isDeleted ? null : row.avatar,
			isOwner: row.isDeleted ? false : row.isOwnerReply,
			isPending: row.isDeleted ? false : row.state === 'pending',
			// A floor placeholder withholds the edit stamp and the authorship
			// flag too: nothing about the removed text leaks through.
			isMine: row.isDeleted ? false : isMine(row),
			editedAt: row.isDeleted ? null : row.editedAt,
			createdAt: row.createdAt,
			pin: row.pin,
			isDeleted: row.isDeleted,
			country: row.isDeleted ? null : publicCountry(row),
			anchor: row.isDeleted ? null : anchor.view,
			replies
		};
		if (anchor.view?.orphaned) {
			orphans.push(entry);
			continue;
		}
		roots.push(entry);
		if (anchor.mark) marks.push(anchor.mark);
	}

	let visibleCount = 0;
	for (const root of roots) visibleCount += 1 + root.replies.length;
	let orphanCount = 0;
	for (const root of orphans) orphanCount += 1 + root.replies.length;

	return {
		threads: {
			roots,
			orphans,
			visibleCount,
			orphanCount,
			truncated: options.truncated ?? false
		},
		marks
	};
}

/* ── Write path ─────────────────────────────────────────────────────────── */

/**
 * Format / zero-width / line-separator characters stripped before validation
 * and storage (security review): an "invisible-only" comment must not pass the
 * empty gate, and bidi controls must not survive into snapshots. ZWJ/ZWNJ are
 * deliberately kept - they are load-bearing inside emoji sequences and some
 * scripts. ALM (U+061C) and the invisible operators (U+2061-U+2064) join the
 * set.
 */
const FORMAT_CHARS =
	/[\u00ad\u061c\u180e\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export function normalizeCommentText(raw: string): string {
	return raw.replace(FORMAT_CHARS, '').trim();
}

/**
 * The empty gate: text that renders as nothing
 * must not pass, so the check strips every Unicode format char (\p{Cf} - a
 * superset of FORMAT_CHARS that also covers a ZWJ/ZWNJ-only payload) before
 * deciding. Stored text still keeps ZWJ/ZWNJ (emoji sequences).
 */
function hasVisibleText(text: string): boolean {
	return text.replace(/\p{Cf}/gu, '').trim().length > 0;
}

// \p{Cc} = control characters; plus the bidi overrides, the Arabic letter
// mark and the shortcut marks.
const AUTHOR_CONTROLS = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
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
 * Resolve a commentable page id from a slug - the pages counterpart of
 * `resolveCommentPostTarget`. Mirrors the universal route's contract:
 * non-external md rows whose current-locale body exists (strict language
 * serving); the servability predicate itself is the shared
 * `servablePageBody` the route and the submit re-check also use.
 */
export async function resolveCommentPageTarget(lang: string, slug: string): Promise<string | null> {
	// Locale tags are never page slugs (the universal route's read-side belt,
	// mirrored here so a legacy locale-shaped row cannot collect comments its
	// page can never display).
	if ((locales as readonly string[]).includes(slug)) return null;
	const row = await getPageBySlug(slug);
	if (!row || servablePageBody(row, lang) === null) return null;
	return row.id;
}

export interface SubmitCommentInput {
	targetType: CommentTargetType;
	/** Target row id, already resolved from the URL by the caller. */
	targetId: string;
	/** URL language; part of the authoritative target re-check. */
	lang: string;
	/**
	 * The caller verified this request's unlock cookie for the target row
	 * (note detail only). Gated rows stay fail-closed unless this explicit
	 * signal is present - comment text must not attach to a diary whose body
	 * sits behind a gate without the unlock.
	 */
	unlockVerified?: boolean;
	/** Root comment id when this submission is a reply. */
	parentId?: string | null;
	/** Segment anchor draft; null/absent = article-level comment. */
	anchor?: CommentAnchorDraft | null;
	text: string;
	/** Signed-in reader; the route resolves the display snapshot. */
	user: { id: string; role?: unknown; emailVerified?: boolean };
	author: string;
	avatar: string | null;
	/**
	 * Request address. Used in-request only: CIDR block,
	 * per-IP bucket, optional GeoIP handoff. NEVER written to the row.
	 */
	ip?: string | null;
	/** Edge GeoIP hints; consulted only with comments.privacy.collectCountry. */
	geo?: { country: string | null; region: string | null } | null;
	/** Commenter's own opt-in for the public country label. */
	showCountry?: boolean;
	/** Test seam: cache store override (defaults to the process-wide store). */
	cache?: CacheStore;
	/** Test seam: clock. */
	now?: Date;
}

export type SubmitCommentResult =
	| { kind: 'created'; id: string; state: 'pending' | 'approved' | 'rejected' }
	| { kind: 'throttled'; windowSeconds: number }
	/** The strict limiter store is down: answer 503, never fail open. */
	| { kind: 'unavailable' }
	| { kind: 'unverified' }
	/** Site-wide `comments.enabled` is off: new comments are closed. */
	| { kind: 'disabled' }
	/** The request address matched a configured blocked CIDR. */
	| { kind: 'blocked' }
	| { kind: 'empty' }
	| { kind: 'too-long'; max: number }
	| { kind: 'target-unavailable' }
	| { kind: 'parent-unavailable' }
	/** The selected text no longer matches the current body. */
	| { kind: 'stale-anchor' };

export async function submitComment(input: SubmitCommentInput): Promise<SubmitCommentResult> {
	const now = input.now ?? new Date();

	// Defense in depth ("verified reader"): the route checks too, but this
	// service is the authoritative layer every future mount will call - it
	// fails closed when the caller forgets the gate.
	if (input.user.emailVerified !== true) return { kind: 'unverified' };

	// The site-wide switch gates NEW comments only - edit/delete of
	// existing rows stay live, and the read path keeps rendering approved rows.
	// A missing/corrupt option row yields the registry default (true) so a bad
	// settings row can never silently close every thread.
	if (!(await getOption('comments.enabled'))) return { kind: 'disabled' };

	// Request-time IP policy. Blocked CIDRs are matched before
	// any target lookup; the address is not recorded anywhere. Privacy off =
	// no CIDR matching and no GeoIP at all, by construction.
	const privacy = await getOption('comments.privacy');
	if (privacy.enabled && input.ip && ipMatchesCidrs(input.ip, privacy.blockedCidrs)) {
		return { kind: 'blocked' };
	}

	// Per-IP strict bucket, independent of the privacy switch (an IP is
	// needed for the limit, not stored). Fail-closed on a dead cache; IPv6 is
	// aggregated on the /64 so a rotating client cannot multiply its budget.
	const addressGuard = await rateLimitStrict(
		input.cache ?? getCache(),
		`limits:comment-ip:${clientAddressKey(input.ip ?? '')}`,
		COMMENT_IP_RATE_LIMIT.limit,
		COMMENT_IP_RATE_LIMIT.windowSeconds
	);
	if (!addressGuard.allowed) {
		return addressGuard.unavailable
			? { kind: 'unavailable' }
			: { kind: 'throttled', windowSeconds: COMMENT_IP_RATE_LIMIT.windowSeconds };
	}

	const text = normalizeCommentText(input.text);
	const length = [...text].length;
	if (length < COMMENT_MIN_LENGTH || !hasVisibleText(text)) return { kind: 'empty' };
	if (length > COMMENT_MAX_LENGTH) return { kind: 'too-long', max: COMMENT_MAX_LENGTH };

	// Anchors belong to roots only. A reply carrying one is either a
	// stale client or a crafted form; reject before any target or render work.
	if (input.parentId && input.anchor) return { kind: 'stale-anchor' };

	// All three arcs are served since the pages mount;
	// each branch below keeps its own authoritative re-check.
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
	} else if (input.targetType === 'note') {
		// Password-gated notes are commentable ONLY for a request that already
		// presented this row's valid unlock cookie (the route verifies it and
		// passes `unlockVerified`); everything else stays fail-closed.
		const gateClause = input.unlockVerified ? [] : [isNull(notes.passwordHash)];
		const [target] = await db
			.select({ id: notes.id, allowComment: notes.allowComment })
			.from(notes)
			.where(
				and(
					eq(notes.id, input.targetId),
					eq(notes.lang, input.lang),
					visibleNoteCondition(now),
					...gateClause
				)
			)
			.limit(1);
		if (!target || !target.allowComment) return { kind: 'target-unavailable' };
	} else {
		// Pages: every md row the universal route can serve is
		// commentable - pages carry no per-row switch. The
		// servability predicate is shared with the resolver and the route;
		// the current language must carry a body (strict language serving).
		const [target] = await db
			.select({
				id: pages.id,
				content: pages.content,
				externalUrl: pages.externalUrl
			})
			.from(pages)
			.where(eq(pages.id, input.targetId))
			.limit(1);
		if (!target || servablePageBody(target, input.lang) === null)
			return { kind: 'target-unavailable' };
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
				pageId: comments.pageId,
				state: comments.state,
				isDeleted: comments.isDeleted,
				rootCommentId: comments.rootCommentId
			})
			.from(comments)
			.where(eq(comments.id, input.parentId))
			.limit(1);
		// A reply needs an approved, undeleted parent on the same target - the
		// same rows the public list shows.
		const parentTargetId =
			input.targetType === 'post'
				? (parent?.postId ?? null)
				: input.targetType === 'note'
					? (parent?.noteId ?? null)
					: (parent?.pageId ?? null);
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

	// Segment anchor: authoritative re-derivation against the CURRENT
	// body. The client supplies only ord/range/exact; hash, occurrence and the
	// quote context are recomputed here, so a stale or forged payload cannot
	// define them. Pages stay deferred (their single row carries all locales).
	let anchorValue: CommentAnchor | null = null;
	if (input.anchor) {
		if (input.targetType === 'page') {
			warnAnchorRejected(input.targetType, input.targetId, 'pages-deferred');
			return { kind: 'stale-anchor' };
		}
		// Charge the anchor-validation budget BEFORE the renderer runs: the official
		// rate-limiter patterns check before the protected work, and this path is
		// the only one that pays a full document render before the main window.
		if (!isAdminRole(input.user.role)) {
			const guard = await rateLimit(
				input.cache ?? getCache(),
				`limits:comment-anchor:${input.user.id}`,
				ANCHOR_RATE_LIMIT.limit,
				ANCHOR_RATE_LIMIT.windowSeconds
			);
			if (!guard.allowed) {
				return { kind: 'throttled', windowSeconds: ANCHOR_RATE_LIMIT.windowSeconds };
			}
			if (guard.count === 0) {
				console.warn('[comments] anchor limiter store unavailable; failing open');
			}
		}
		const body = await loadTargetBody(input, now);
		if (body === null) return { kind: 'target-unavailable' };
		const draft = parseCommentAnchorDraft(input.anchor);
		if (!draft) {
			warnAnchorRejected(input.targetType, input.targetId, 'draft-invalid');
			return { kind: 'stale-anchor' };
		}
		// Loaded lazily: the renderer drags in Shiki/KaTeX, and this module is also
		// imported by scripts and by every comment test that never touches anchors.
		const { renderMarkdownTree } = await import('$lib/server/markdown');
		const tree = await renderMarkdownTree(body);
		const resolved = resolveAnchorDraft(collectAnchorBlocks(tree), draft, input.lang);
		if (resolved.kind !== 'ok') {
			warnAnchorRejected(input.targetType, input.targetId, 'quote-not-found');
			return { kind: 'stale-anchor' };
		}
		// Belt: the value that reaches jsonb must be readable by the same schema
		// the read path uses (a 1-code-point range once slipped through here).
		if (!commentAnchorSchema.safeParse(resolved.anchor).success) {
			warnAnchorRejected(input.targetType, input.targetId, 'schema-reject');
			return { kind: 'stale-anchor' };
		}
		anchorValue = resolved.anchor;
	}

	// Owner/admin posts skip the window (WordPress core exempts moderators);
	// everyone else shares one cross-target window per reader.
	// The window is charged only AFTER validation succeeded, so validation
	// failures never eat the reader's budget; a race loser (CAS 0 rows / FK
	// 23503) keeps its charge - Valkey and PG share no transaction, so there
	// is no cross-store rollback.
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
			// signature (the store threw): deliberate, but it must
			// never happen silently (security review).
			console.warn('[comments] rate limiter store unavailable; failing open');
		}
	}

	// Policy: ip/agent/location/country_code are never collected;
	// the display snapshot is sanitised and frozen at write time. The arc
	// column is picked per target type; the values are otherwise identical.
	const arc =
		input.targetType === 'post'
			? { postId: input.targetId }
			: input.targetType === 'note'
				? { noteId: input.targetId }
				: { pageId: input.targetId };
	const moderation = await evaluateCommentModeration({
		text,
		readerId: input.user.id,
		autoApprove
	});
	const state = autoApprove ? 'approved' : (moderation?.state ?? 'pending');
	// Country/region are stored only with the privacy switch and the
	// collectCountry sub-switch; the public label additionally needs the site's
	// showCountry and the commenter's own opt-in. The raw IP/agent/location
	// columns stay null - they are never written by this path.
	const collectGeo = !parentCommentId && privacy.enabled && privacy.collectCountry;
	const countryCode = collectGeo ? normalizeCountry(input.geo?.country) : null;
	const regionCode = collectGeo ? normalizeRegion(input.geo?.region) : null;
	const privacyMeta =
		countryCode && privacy.showCountry && input.showCountry ? { showCountry: true } : null;
	const authorName = normalizeCommentAuthor(input.author);
	try {
		// The comment insert and the `comment.pending` outbox row
		// share ONE transaction. The enqueue creates its own savepoint and
		// swallows its failures, so a broken notification path can never roll
		// back the reader's comment - the alert is best-effort, the comment is
		// not (the outbox is written in the comment transaction; failure never blocks business).
		const [created] = await db.transaction(async (tx) => {
			const inserted = await tx
				.insert(comments)
				.values({
					...arc,
					readerId: input.user.id,
					author: authorName,
					avatar: normalizeCommentAvatar(input.avatar),
					text,
					state,
					isOwnerReply: autoApprove,
					parentCommentId,
					rootCommentId,
					anchor: anchorValue,
					countryCode,
					regionCode,
					meta: privacyMeta,
					reviewedBy: autoApprove ? input.user.id : null,
					// reviewed_at/by are human-decision columns: machine rule outcomes
					// keep them null so the audit trail cannot read as a human review.
					reviewedAt: autoApprove ? now : null
				})
				.returning({ id: comments.id, state: comments.state });
			const row = inserted[0];
			// Only a queue entry is worth an alert: an auto-approved owner reply
			// or a machine-rejected row has nothing to moderate.
			if (row?.state === 'pending') {
				try {
					await enqueueNotification(tx as unknown as NotificationOutboxDb, {
						eventType: 'comment.pending',
						eventKey: `comment:${row.id}`,
						title: 'New comment awaiting review',
						body: `${authorName}: ${text}`,
						url: env.ORIGIN ? `${env.ORIGIN.replace(/\/$/, '')}/admin/comments` : null
					});
				} catch (error) {
					// Belt over the outbox's own savepoint: even a thrown enqueue
					// must not roll back the reader's comment (the alert is
					// best-effort; the comment is the business write).
					console.warn(
						'[comments] pending notification enqueue failed',
						error instanceof Error ? error.name : 'unknown'
					);
				}
			}
			return inserted;
		});
		await recordModerationEvents(created.id, moderation);
		return {
			kind: 'created',
			id: created.id,
			state: created.state as 'pending' | 'approved' | 'rejected'
		};
	} catch (caught) {
		// The target or parent row was hard-deleted between validation and
		// insert (FK violation): surface the same unavailable outcome instead
		// of an unhandled 500 (database review).
		if (pgErrorCode(caught) === '23503') {
			// The likelier loser in a reply race is the parent row; a root
			// submission can only lose its target.
			return { kind: input.parentId ? 'parent-unavailable' : 'target-unavailable' };
		}
		throw caught;
	}
}

/**
 * Current body markdown for anchor validation, re-read with the same
 * visibility/gate predicates the submission already passed. Deliberately
 * lazy (anchored submissions only) and shared by every arc: a second copy in
 * the routes would be the place the ruler drifts.
 */
async function loadTargetBody(input: SubmitCommentInput, now: Date): Promise<string | null> {
	if (input.targetType === 'post') {
		const [row] = await db
			.select({ content: posts.content })
			.from(posts)
			.where(
				and(
					eq(posts.id, input.targetId),
					eq(posts.lang, input.lang),
					// Second query: re-check the switch so a concurrent "comments off"
					// cannot land a comment through the narrow gap.
					eq(posts.allowComment, true),
					visiblePostCondition(now)
				)
			)
			.limit(1);
		return row?.content ?? null;
	}
	if (input.targetType === 'note') {
		const gateClause = input.unlockVerified ? [] : [isNull(notes.passwordHash)];
		const [row] = await db
			.select({ content: notes.content })
			.from(notes)
			.where(
				and(
					eq(notes.id, input.targetId),
					eq(notes.lang, input.lang),
					eq(notes.allowComment, true),
					visibleNoteCondition(now),
					...gateClause
				)
			)
			.limit(1);
		return row?.content ?? null;
	}
	// Pages: segment comments deferred - never validated here.
	return null;
}

/* ── Reader self-service: edit / soft-delete ────────────────────────────── */

export interface EditCommentInput {
	commentId: string;
	text: string;
	/** Signed-in author; the service is the authoritative ownership gate. */
	user: { id: string; role?: unknown; emailVerified?: boolean };
	/** Test seam: cache store override (defaults to the process-wide store). */
	cache?: CacheStore;
	/** Test seam: clock. */
	now?: Date;
}

export type EditCommentResult =
	| { kind: 'updated'; state: 'pending' | 'approved' | 'rejected' }
	| { kind: 'throttled'; windowSeconds: number }
	| { kind: 'unverified' }
	| { kind: 'empty' }
	| { kind: 'too-long'; max: number }
	| { kind: 'unavailable' };

/**
 * Author-only edit: the new text always re-enters review - an
 * approved comment drops back to `pending`, so a post-approval rewrite can
 * never ride the old approval ("inject after approval" guard) - and gets the public
 * `edited_at` stamp. Owner/admin edits auto-approve like their submissions
 * and skip the window. A missing row, a foreign author, a deleted row and a
 * rejected row are one indistinguishable `unavailable` (fail-closed).
 * `pin` intentionally stays on an edit (a moderator signal on the row,
 * restored with the re-approval); delete clears it instead.
 * Concurrent same-reader edits are last-write-wins - no OCC token, accepted
 * and registered.
 */
export async function editComment(input: EditCommentInput): Promise<EditCommentResult> {
	const now = input.now ?? new Date();

	// Defense in depth (mirrors submitComment): the route checks too, but the
	// service stays fail-closed when a future mount forgets the gate.
	if (input.user.emailVerified !== true) return { kind: 'unverified' };

	if (!isUuid(input.commentId)) return { kind: 'unavailable' };

	const text = normalizeCommentText(input.text);
	const length = [...text].length;
	if (length < COMMENT_MIN_LENGTH || !hasVisibleText(text)) return { kind: 'empty' };
	if (length > COMMENT_MAX_LENGTH) return { kind: 'too-long', max: COMMENT_MAX_LENGTH };

	const [row] = await db
		.select({
			id: comments.id,
			text: comments.text,
			state: comments.state,
			isDeleted: comments.isDeleted,
			readerId: comments.readerId
		})
		.from(comments)
		.where(eq(comments.id, input.commentId))
		.limit(1);

	if (
		!row ||
		row.readerId !== input.user.id ||
		row.isDeleted ||
		(row.state !== 'pending' && row.state !== 'approved')
	) {
		return { kind: 'unavailable' };
	}

	// Unchanged payload: no write, no edit stamp, no window charge.
	if (text === row.text) return { kind: 'updated', state: row.state as 'pending' | 'approved' };

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
			// rateLimit() fail-open signature (the store threw): deliberate,
			// but never silent (security review; mirrors submitComment).
			console.warn('[comments] rate limiter store unavailable; failing open');
		}
	}

	// Clearing reviewed_by/at keeps the queue honest: the previous decision
	// no longer covers the new text (the review batch re-stamps an approval).
	const moderation = await evaluateCommentModeration({
		text,
		readerId: input.user.id,
		autoApprove
	});
	const state = autoApprove ? 'approved' : (moderation?.state ?? 'pending');
	const updated = await db
		.update(comments)
		.set({
			text,
			editedAt: now,
			state,
			reviewedBy: autoApprove ? input.user.id : null,
			// reviewed_at/by are human-decision columns: machine rule outcomes keep
			// them null so the audit trail cannot read as a human review.
			reviewedAt: autoApprove ? now : null
		})
		.where(
			and(
				eq(comments.id, row.id),
				eq(comments.readerId, input.user.id),
				eq(comments.isDeleted, false),
				// A concurrent rejection must not be revived by this write.
				// `approved` deliberately stays allowed: the
				// edit pulls it back to pending - the "inject after approval" guard.
				inArray(comments.state, ['pending', 'approved'])
			)
		)
		.returning({ id: comments.id });
	if (updated.length === 0) return { kind: 'unavailable' }; // raced a delete or a rejection

	return { kind: 'updated', state };
}

export interface DeleteCommentInput {
	commentId: string;
	user: { id: string; emailVerified?: boolean };
	/** Test seam: clock. */
	now?: Date;
}

export type DeleteCommentResult =
	{ kind: 'deleted' } | { kind: 'unverified' } | { kind: 'unavailable' };

/**
 * Author-only soft delete: the moderation axis stays untouched so
 * an approved root with replies keeps its floor placeholder; `pin` drops -
 * a removed comment must not stay highlighted. Not
 * throttled: retraction is not a spam vector. One single-statement CAS:
 * the former pre-read was fully redundant with the UPDATE's predicate.
 * A replay answers 404 - state-idempotent, the response is not.
 */
export async function deleteComment(input: DeleteCommentInput): Promise<DeleteCommentResult> {
	const now = input.now ?? new Date();

	// Mirrors editComment: fail closed when the caller forgets the gate.
	if (input.user.emailVerified !== true) return { kind: 'unverified' };

	if (!isUuid(input.commentId)) return { kind: 'unavailable' };

	const updated = await db
		.update(comments)
		.set({
			isDeleted: true,
			deletedAt: now,
			pin: false,
			// Erasure: a retracted comment keeps no location snapshot and
			// no country opt-in flag (the approved floor placeholder never
			// renders them either, but the row itself is minimised).
			countryCode: null,
			regionCode: null,
			meta: null
		})
		.where(
			and(
				eq(comments.id, input.commentId),
				eq(comments.readerId, input.user.id),
				eq(comments.isDeleted, false),
				// Aligned with editComment: a concurrently rejected row must
				// not pass through this window either.
				inArray(comments.state, ['pending', 'approved'])
			)
		)
		.returning({ id: comments.id });
	if (updated.length === 0) return { kind: 'unavailable' };

	return { kind: 'deleted' };
}
