import { error, fail } from '@sveltejs/kit';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { postTags, posts, tags } from '$lib/server/db/content';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';
import { isValidTaxonomySlug } from '$lib/server/services/taxonomy';

export const load: PageServerLoad = async ({ params }) => {
	await requireAdminRole();
	if (!isUuid(params.id)) error(404, m.admin_tags_select());

	const [tag] = await db
		.select({
			id: tags.id,
			name: tags.name,
			slug: tags.slug,
			description: tags.description
		})
		.from(tags)
		.where(eq(tags.id, params.id));
	if (!tag) error(404, m.admin_tags_select());

	// Tags are M:N: these are posts carrying the tag, not posts owned by it.
	const related = await db
		.select({
			id: posts.id,
			title: posts.title,
			slug: posts.slug,
			status: posts.status,
			lang: posts.lang,
			updatedAt: posts.updatedAt
		})
		.from(postTags)
		.innerJoin(posts, eq(posts.id, postTags.postId))
		.where(eq(postTags.tagId, params.id))
		.orderBy(sql`${posts.updatedAt} desc nulls last`, sql`${posts.createdAt} desc`)
		.limit(200);

	// Candidates for "add tag": every post not already carrying it. Capped —
	// a personal blog's archive is small enough to filter client-side.
	const pickable = await db
		.select({
			id: posts.id,
			title: posts.title,
			status: posts.status,
			lang: posts.lang
		})
		.from(posts)
		.where(
			notInArray(
				posts.id,
				db.select({ postId: postTags.postId }).from(postTags).where(eq(postTags.tagId, params.id))
			)
		)
		.orderBy(sql`${posts.updatedAt} desc nulls last`)
		.limit(200);

	return {
		headerActions: [
			{
				label: m.admin_common_back_to_list(),
				iconName: 'arrow-left',
				variant: 'ghost',
				href: '/admin/posts/tags'
			},
			{
				label: m.admin_common_delete(),
				iconName: 'trash',
				variant: 'outline',
				actionId: 'tags:delete'
			}
		],
		tag,
		related,
		pickable
	};
};

export const actions: Actions = {
	update: async ({ params, request }) => {
		await requireAdminRole();
		const formData = await request.formData();
		const name = formData.get('name')?.toString().trim();
		const slug = formData.get('slug')?.toString().trim().toLowerCase();

		if (!isUuid(params.id)) return fail(400, { error: m.admin_tags_err_missing_id() });
		if (!name) return fail(400, { error: m.admin_tags_err_name_required() });
		if (!slug) return fail(400, { error: m.admin_tags_err_slug_required() });
		if (!isValidTaxonomySlug(slug)) return fail(400, { error: m.admin_taxonomy_err_slug_shape() });

		try {
			const updatedRows = await db
				.update(tags)
				.set({
					name,
					slug,
					description: formData.get('description')?.toString().trim() || null
				})
				.where(eq(tags.id, params.id))
				.returning({ id: tags.id });
			if (updatedRows.length === 0) return fail(404, { error: m.admin_tags_select() });
		} catch (caught) {
			if (pgErrorCode(caught) === '23505') {
				return fail(409, { error: m.admin_tags_err_duplicate() });
			}
			throw caught;
		}
		return { success: true };
	},

	/**
	 * Add or remove the tag on posts. One action covers both verbs the
	 * workspace offers; `op` picks the direction. Unlike categories there is no
	 * destination to choose — a post can carry many tags, so "removing" only
	 * drops the association and never touches the post itself.
	 */
	link: async ({ params, request }) => {
		await requireAdminRole();
		const formData = await request.formData();
		const postIds = formData.getAll('postId').map(String).filter(isUuid);
		if (postIds.length === 0) return fail(400, { error: m.admin_tags_err_no_selection() });
		if (!isUuid(params.id)) return fail(400, { error: m.admin_tags_err_missing_id() });

		const op = formData.get('op')?.toString();
		if (op === 'detach') {
			await db
				.delete(postTags)
				.where(and(eq(postTags.tagId, params.id), inArray(postTags.postId, postIds)));
		} else if (op === 'attach') {
			await db
				.insert(postTags)
				.values(postIds.map((postId) => ({ postId, tagId: params.id })))
				.onConflictDoNothing();
		} else {
			return fail(400, { error: m.admin_tags_err_no_selection() });
		}
		return { success: true, changed: postIds.length };
	},

	delete: async ({ params }) => {
		await requireAdminRole();
		if (!isUuid(params.id)) return fail(400, { error: m.admin_tags_err_missing_id() });

		// `post_tags.tag_id` cascades, so a tag with posts can go in one step:
		// only the association rows disappear, the posts are untouched.
		const deletedRows = await db
			.delete(tags)
			.where(eq(tags.id, params.id))
			.returning({ id: tags.id });
		if (deletedRows.length === 0) return fail(404, { error: m.admin_tags_select() });
		return { success: true, deleted: params.id };
	}
};
