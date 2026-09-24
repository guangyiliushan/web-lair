import { fail } from '@sveltejs/kit';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { comments } from '$lib/server/db/content/comment.schema';
import { posts } from '$lib/server/db/content/post.schema';
import { can, requireCommentReviewer } from '$lib/server/authz';
import type { Actions, PageServerLoad } from './$types';

const STATES = ['pending', 'approved', 'rejected'] as const;
type ReviewState = (typeof STATES)[number];

function parseState(value: string | null): ReviewState {
	return (STATES as readonly string[]).includes(value ?? '') ? (value as ReviewState) : 'pending';
}

export const load: PageServerLoad = async (event) => {
	await requireCommentReviewer();
	const state = parseState(event.url.searchParams.get('state'));

	const entries = await db
		.select({
			id: comments.id,
			author: comments.author,
			text: comments.text,
			state: comments.state,
			ip: comments.ip,
			createdAt: comments.createdAt,
			reviewedAt: comments.reviewedAt,
			postId: comments.postId,
			postTitle: posts.title,
			postSlug: posts.slug
		})
		.from(comments)
		.leftJoin(posts, eq(comments.postId, posts.id))
		.where(and(eq(comments.state, state), eq(comments.isDeleted, false)))
		.orderBy(desc(comments.createdAt))
		.limit(200);

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
		const ids = form
			.getAll('ids')
			.map((value) => value.toString())
			.filter(Boolean);

		if ((decision !== 'approve' && decision !== 'reject') || ids.length === 0) {
			return fail(400, { message: 'Select at least one comment first.' });
		}
		if (!(await can.reviewComment())) {
			return fail(403, { message: 'Comment review permission required.' });
		}

		// Only pending rows flip: the conditional update keeps a repeated submit
		// (double click, replay) from overwriting an existing decision.
		const state = decision === 'approve' ? 'approved' : 'rejected';
		const updated = await db
			.update(comments)
			.set({ state, reviewedBy: reviewer.id, reviewedAt: new Date() })
			.where(and(inArray(comments.id, ids), eq(comments.state, 'pending')))
			.returning({ id: comments.id });

		return { reviewed: updated.length, decision };
	}
};
