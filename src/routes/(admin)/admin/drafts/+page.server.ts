import { asc, eq } from 'drizzle-orm';
import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { drafts, posts } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { discardDraft } from '$lib/server/services/post-drafts';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';

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
			title: row.draftTitle || row.postTitle || '(无标题)',
			kind,
			lang: row.postLang ?? '-',
			postStatus: row.postStatus,
			version: row.draftVersion,
			updatedAt: row.draftUpdatedAt
		};
	});

	return { headerTitle: '草稿箱', drafts: items };
};

export const actions: Actions = {
	discard: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const draftId = (form.get('draftId') ?? '').toString();
		if (!draftId || !isUuid(draftId)) return fail(400, { message: '草稿标识无效' });

		const result = await discardDraft(draftId);
		if (result.kind === 'not-found') return fail(404, { message: '草稿不存在' });
		throw redirect(303, '/admin/drafts?discarded=1');
	}
} satisfies Actions;
