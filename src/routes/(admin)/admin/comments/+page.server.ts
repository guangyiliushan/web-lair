import { fail } from '@sveltejs/kit';
import { m } from '$lib/paraglide/messages';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { comments } from '$lib/server/db/content/comment.schema';
import { commentModerationEvents } from '$lib/server/db/content/comment-moderation-event.schema';
import { notes } from '$lib/server/db/content/note.schema';
import { pages } from '$lib/server/db/content/page.schema';
import { posts } from '$lib/server/db/content/post.schema';
import { can, getUserRole, requireCommentReviewer } from '$lib/server/authz';
import { parseCommentAnchor } from '$lib/server/comment-anchor';
import { isUuid } from '$lib/utils/uuid';
import type { Actions, PageServerLoad } from './$types';

const STATES = ['pending', 'approved', 'rejected'] as const;
type ReviewState = (typeof STATES)[number];

function parseState(value: string | null): ReviewState {
	return (STATES as readonly string[]).includes(value ?? '') ? (value as ReviewState) : 'pending';
}

export const load: PageServerLoad = async (event) => {
	const reviewer = await requireCommentReviewer();
	// A reviewer may lack access to password-gated notes; the queue must not
	// become a side channel into their body text.
	const role = getUserRole(reviewer);
	const canReadGatedNotes = role === 'owner' || role === 'admin';
	const state = parseState(event.url.searchParams.get('state'));

	// Resolve the exclusive-arc target for all three kinds so note/page rows stop
	// falling into "other targets"; the quote/block context comes from the anchor.
	const rows = await db
		.select({
			id: comments.id,
			author: comments.author,
			text: comments.text,
			state: comments.state,
			ip: comments.ip,
			createdAt: comments.createdAt,
			reviewedAt: comments.reviewedAt,
			editedAt: comments.editedAt,
			postId: comments.postId,
			postTitle: posts.title,
			postSlug: posts.slug,
			postLang: posts.lang,
			postStatus: posts.status,
			noteId: comments.noteId,
			noteTitle: notes.title,
			noteSlug: notes.slug,
			noteLang: notes.lang,
			notePasswordHash: notes.passwordHash,
			noteStatus: notes.status,
			pageId: comments.pageId,
			pageTitle: pages.title,
			pageSlug: pages.slug,
			pageStatus: pages.status,
			anchor: comments.anchor
		})
		.from(comments)
		.leftJoin(posts, eq(comments.postId, posts.id))
		.leftJoin(notes, eq(comments.noteId, notes.id))
		.leftJoin(pages, eq(comments.pageId, pages.id))
		.where(and(eq(comments.state, state), eq(comments.isDeleted, false)))
		// Edited rows float to the position of their last touch: an old
		// comment pulled back into review must not sink below the fold.
		.orderBy(sql`coalesce(${comments.editedAt}, ${comments.createdAt}) desc`)
		.limit(200);

	// Segment anchors: the queue shows the quoted text plus its prefix/suffix
	// window. Deliberately no block snapshot and no re-render of the target body
	// here - the context comes from the anchor itself.
	const entries = rows.map((row) => {
		// Never ship the stored payload (hash/occ/ord/range/exact/prefix/suffix)
		// to the browser: the queue renders only the excerpt and its context.
		const {
			anchor: rawAnchor,
			notePasswordHash,
			postStatus,
			noteStatus,
			pageStatus,
			...rest
		} = row;
		const anchor = parseCommentAnchor(rawAnchor);
		// Reviewers may lack access to password-gated notes *and* to unpublished
		// targets; the queue must not become a reader for either (round-4 review).
		const targetPublic =
			(row.postId !== null && postStatus === 'published') ||
			(row.noteId !== null && noteStatus === 'published') ||
			(row.pageId !== null && pageStatus === 'visible');
		const gated = !canReadGatedNotes && (notePasswordHash !== null || !targetPublic);
		return {
			...rest,
			anchorGated: gated,
			anchorQuote: gated ? null : (anchor?.quote.exact ?? null),
			// The quote already has its own line; context contributes what sits
			// around it (prefix + suffix), without repeating the exact text.
			anchorContext: gated
				? null
				: anchor
					? [anchor.quote.prefix, anchor.quote.suffix].filter((part) => part.length > 0).join(' ')
					: null
		};
	});

	const ids = entries.map((entry) => entry.id);
	const moderationRows =
		ids.length > 0
			? await db
					.select({
						id: commentModerationEvents.id,
						commentId: commentModerationEvents.commentId,
						source: commentModerationEvents.source,
						ruleId: commentModerationEvents.ruleId,
						outcome: commentModerationEvents.outcome,
						applied: commentModerationEvents.applied,
						score: commentModerationEvents.score,
						detail: commentModerationEvents.detail,
						createdAt: commentModerationEvents.createdAt
					})
					.from(commentModerationEvents)
					.where(inArray(commentModerationEvents.commentId, ids))
					.orderBy(desc(commentModerationEvents.createdAt))
			: [];
	const moderationByComment = new Map<string, typeof moderationRows>();
	for (const row of moderationRows) {
		const list = moderationByComment.get(row.commentId) ?? [];
		list.push(row);
		moderationByComment.set(row.commentId, list);
	}
	const withModeration = entries.map((entry) => ({
		...entry,
		moderation: moderationByComment.get(entry.id) ?? []
	}));
	const grouped = await db
		.select({ state: comments.state, count: sql<number>`count(*)::int` })
		.from(comments)
		.where(eq(comments.isDeleted, false))
		.groupBy(comments.state);

	const counts: Record<ReviewState, number> = { pending: 0, approved: 0, rejected: 0 };
	for (const row of grouped) {
		if ((STATES as readonly string[]).includes(row.state)) {
			counts[row.state as ReviewState] = row.count;
		}
	}

	return { state, entries: withModeration, counts };
};

export const actions: Actions = {
	review: async (event) => {
		// Form actions do not re-run the layout guard, so the permission is
		// checked here again: page guard + action guard (defense in depth).
		const reviewer = await requireCommentReviewer();
		const form = await event.request.formData();
		const decision = form.get('decision')?.toString();
		if (decision !== 'approve' && decision !== 'reject') {
			return fail(400, { message: m.admin_comments_err_unknown_decision() });
		}
		// Snapshot guard (pre-release review 08-F1): the queue form carries,
		// per row, the `edited_at` the reviewer actually saw. Editing a
		// pending row made its text mutable, so approving without this axis
		// could put text the reviewer never read onto the public surface
		// (TOCTOU). A row whose snapshot no longer matches stays untouched.
		const snapshots = new Map<string, number>();
		for (const raw of form.getAll('seen')) {
			const [id, rawTs] = raw.toString().split(':');
			const ts = Number(rawTs);
			if (isUuid(id) && Number.isSafeInteger(ts) && ts >= 0) snapshots.set(id, ts);
		}
		// Same cap as the list query: one request must not flip the whole
		// table. Non-uuid values are dropped before they reach the uuid
		// column (PG would raise 22P02 → 500); rows without a
		// snapshot are not approvable at all.
		const ids = form
			.getAll('ids')
			.map((value) => value.toString())
			.filter(isUuid)
			.filter((id) => snapshots.has(id))
			.slice(0, 200);
		if (ids.length === 0) {
			return fail(400, { message: m.admin_comments_err_select_first() });
		}
		// The capability is checked per decision, not by the coarse review
		// marker (B2.1 review fix: declared actions and enforced actions match).
		const allowed = decision === 'approve' ? await can.approveComment() : await can.rejectComment();
		if (!allowed) {
			return fail(403, { message: m.admin_comments_err_permission() });
		}

		// Only pending, non-deleted rows flip, and only while the edited_at
		// snapshot the reviewer saw still matches: the conditional update
		// keeps a repeated submit (double click, replay) from overwriting a
		// decision, keeps the writable set identical to the visible one, and
		// cannot approve text the reviewer never read (pre-release review
		// 08-F1).
		const state = decision === 'approve' ? 'approved' : 'rejected';
		const conditions: SQL<unknown>[] = ids.map((id) => {
			const ts = snapshots.get(id) ?? 0;
			const snapshot = ts === 0 ? isNull(comments.editedAt) : eq(comments.editedAt, new Date(ts));
			return and(eq(comments.id, id), snapshot) as SQL<unknown>;
		});
		const updated = await db
			.update(comments)
			.set({ state, reviewedBy: reviewer.id, reviewedAt: new Date() })
			.where(
				and(
					inArray(comments.id, ids),
					// Approve may also restore a rule-rejected row; reject stays
					// pending-only (a decided row is not re-rejectable).
					decision === 'approve'
						? inArray(comments.state, ['pending', 'rejected'])
						: eq(comments.state, 'pending'),
					eq(comments.isDeleted, false),
					or(...conditions)
				)
			)
			.returning({ id: comments.id });

		// A shortfall means one or more rows changed underneath the reviewer
		// (edited after load, or decided elsewhere): surface the count
		// honestly so a stale click cannot masquerade as a full success.
		const stale = ids.length - updated.length;
		return { reviewed: updated.length, decision, stale };
	}
};
