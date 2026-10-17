import { fail } from '@sveltejs/kit';
import { m } from '$lib/paraglide/messages';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { comments } from '$lib/server/db/content/comment.schema';
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
	// become a side channel into their body text (B2 review, angle 2).
	const role = getUserRole(reviewer);
	const canReadGatedNotes = role === 'owner' || role === 'admin';
	const state = parseState(event.url.searchParams.get('state'));

	// Comment P3a queue enhancement (spec §9): resolve the exclusive-arc
	// target for all three kinds so note/page rows stop falling into
	// "other targets"; quote/block context lands with P3b (anchors).
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
			noteId: comments.noteId,
			noteTitle: notes.title,
			noteSlug: notes.slug,
			noteLang: notes.lang,
			notePasswordHash: notes.passwordHash,
			pageId: comments.pageId,
			pageTitle: pages.title,
			pageSlug: pages.slug,
			anchor: comments.anchor
		})
		.from(comments)
		.leftJoin(posts, eq(comments.postId, posts.id))
		.leftJoin(notes, eq(comments.noteId, notes.id))
		.leftJoin(pages, eq(comments.pageId, pages.id))
		.where(and(eq(comments.state, state), eq(comments.isDeleted, false)))
		// Edited rows float to the position of their last touch: an old
		// comment pulled back into review must not sink below the fold
		// (pre-release review 05-P3-2).
		.orderBy(sql`coalesce(${comments.editedAt}, ${comments.createdAt}) desc`)
		.limit(200);

	// Segment anchors (comment P3b): the queue shows the quoted text plus its
	// prefix/suffix window. Deliberately no block snapshot and no re-render of
	// the target body here - the context comes from the anchor itself.
	const entries = rows.map((row) => {
		// Never ship the stored payload (hash/occ/ord/range/exact/prefix/suffix)
		// to the browser: the queue renders only the excerpt and its context.
		const { anchor: rawAnchor, notePasswordHash, ...rest } = row;
		const anchor = parseCommentAnchor(rawAnchor);
		const gated = notePasswordHash !== null && !canReadGatedNotes;
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

	return { state, entries, counts };
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
		// column (PG would raise 22P02 → 500; P1.1 review); rows without a
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
					eq(comments.state, 'pending'),
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
