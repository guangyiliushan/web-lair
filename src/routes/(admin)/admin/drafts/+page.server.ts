import { asc, eq } from 'drizzle-orm';
import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { drafts, posts } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { discardDraft } from '$lib/server/services/post-drafts';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * Draft management (ledger §9.14.3): every pending working copy, oldest
 * activity first, with explicit discard. No auto-cleanup by design.
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();

	const rows = await db
		.select({
			draftId: drafts.id,
			draftTitle: drafts.title,
			draftVersion: drafts.version,
			draftUpdatedAt: drafts.updatedAt,
			postId: posts.id,
			postTitle: posts.title,
			postStatus: posts.status,
			postLang: posts.lang,
			translatedFrom: posts.translatedFromPostId
		})
		.from(drafts)
		.leftJoin(posts, eq(drafts.refId, posts.id))
		.where(eq(drafts.refType, 'post'))
		.orderBy(asc(drafts.updatedAt));

	const items = rows.map((row) => {
		const kind: 'new' | 'translation' | 'edit' = !row.postId
			? 'new'
			: row.translatedFrom
				? 'translation'
				: 'edit';
		return {
			draftId: row.draftId,
			postId: row.postId,
			title: row.draftTitle || row.postTitle || m.admin_drafts_untitled(),
			kind,
			lang: row.postLang ?? '-',
			postStatus: row.postStatus,
			version: row.draftVersion,
			updatedAt: row.draftUpdatedAt
		};
	});

	return { headerTitle: m.admin_nav_drafts(), drafts: items };
};

export const actions: Actions = {
	discard: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const draftId = (form.get('draftId') ?? '').toString();
		if (!draftId || !isUuid(draftId))
			return fail(400, { message: m.admin_posts_edit_err_bad_draft_id() });

		const result = await discardDraft(draftId);
		if (result.kind === 'not-found')
			return fail(404, { message: m.admin_posts_edit_err_draft_not_found() });
		if (result.kind === 'busy') return fail(409, { message: m.admin_posts_edit_err_busy() });
		throw redirect(303, '/admin/drafts?discarded=1');
	}
} satisfies Actions;
