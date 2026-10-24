import { error, fail } from '@sveltejs/kit';
import { eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { categories, posts } from '$lib/server/db/content';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';
import { isValidTaxonomySlug, parseTaxonomyI18n } from '$lib/server/services/taxonomy';

/**
 * The fallback bucket every post is filed under. `posts.category_id` is NOT
 * NULL with `on delete restrict`, so "no category" is not a state a post can
 * be in — clearing a category means moving its posts here.
 */
async function defaultCategoryId(): Promise<string | null> {
	const [row] = await db
		.select({ id: categories.id })
		.from(categories)
		.where(eq(categories.isDefault, true))
		.limit(1);
	return row?.id ?? null;
}

export const load: PageServerLoad = async ({ params }) => {
	await requireAdminRole();
	if (!isUuid(params.id)) error(404, m.admin_categories_select());

	const [category] = await db
		.select({
			id: categories.id,
			name: categories.name,
			slug: categories.slug,
			description: categories.description,
			sortOrder: categories.sortOrder,
			sourceLang: categories.sourceLang,
			nameI18n: categories.nameI18n,
			isDefault: categories.isDefault
		})
		.from(categories)
		.where(eq(categories.id, params.id));
	if (!category) error(404, m.admin_categories_select());

	// The workspace list needs enough per row to decide without opening the
	// post: language, state, and when it last moved.
	const related = await db
		.select({
			id: posts.id,
			title: posts.title,
			slug: posts.slug,
			status: posts.status,
			lang: posts.lang,
			updatedAt: posts.updatedAt
		})
		.from(posts)
		.where(eq(posts.categoryId, params.id))
		.orderBy(sql`${posts.updatedAt} desc nulls last`, sql`${posts.createdAt} desc`)
		.limit(200);

	// Candidates for "pull in": everything filed elsewhere, with the category
	// it currently sits in so the owner can see what they are about to move.
	// Capped — a personal blog's archive is small enough to filter client-side.
	const pickable = await db
		.select({
			id: posts.id,
			title: posts.title,
			status: posts.status,
			lang: posts.lang,
			categoryName: categories.name
		})
		.from(posts)
		.innerJoin(categories, eq(posts.categoryId, categories.id))
		.where(ne(posts.categoryId, params.id))
		.orderBy(sql`${posts.updatedAt} desc nulls last`)
		.limit(200);

	// Header actions for a selected record. Destructive work is never primary
	// (Apple HIG, Buttons), and nothing here is "Save": edits autosave. The
	// fallback category is not deletable, so it gets no delete action at all.
	return {
		headerActions: [
			{
				label: m.admin_common_back_to_list(),
				iconName: 'arrow-left',
				variant: 'ghost',
				href: '/admin/posts/categories'
			},
			...(category.isDefault
				? []
				: [
						{
							label: m.admin_common_delete(),
							iconName: 'trash',
							variant: 'outline',
							actionId: 'categories:delete'
						}
					])
		],
		category,
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

		if (!isUuid(params.id)) return fail(400, { error: m.admin_categories_err_missing_id() });
		if (!name) return fail(400, { error: m.admin_categories_err_name_required() });
		if (!slug) return fail(400, { error: m.admin_categories_err_slug_required() });
		if (!isValidTaxonomySlug(slug)) return fail(400, { error: m.admin_taxonomy_err_slug_shape() });

		// `source_lang` is locked after creation: read it from the row instead of
		// trusting the form, and build the translation map around it.
		const [current] = await db
			.select({ sourceLang: categories.sourceLang })
			.from(categories)
			.where(eq(categories.id, params.id))
			.limit(1);
		if (!current) return fail(404, { error: m.admin_categories_select() });

		const nameI18n = parseTaxonomyI18n(formData, 'name', current.sourceLang);

		const updatedRows = await db
			.update(categories)
			.set({
				name,
				slug,
				nameI18n,
				description: formData.get('description')?.toString().trim() || null
			})
			.where(eq(categories.id, params.id))
			.returning({ id: categories.id });
		if (updatedRows.length === 0) return fail(404, { error: m.admin_categories_select() });
		return { success: true };
	},

	/**
	 * Re-file posts. One action covers all three verbs the workspace offers:
	 *   · "clear out"   -> `to` blank, lands in the fallback category
	 *   · "move to…"    -> `to` names the destination
	 *   · "pull in"     -> `to` is this route's category
	 */
	move: async ({ request }) => {
		await requireAdminRole();
		const formData = await request.formData();
		const postIds = formData.getAll('postId').map(String).filter(isUuid);
		if (postIds.length === 0) return fail(400, { error: m.admin_categories_err_no_selection() });

		const toRaw = formData.get('to')?.toString().trim() ?? '';
		let target: string;
		if (toRaw === '') {
			const fallback = await defaultCategoryId();
			if (!fallback) return fail(409, { error: m.admin_categories_err_no_default() });
			target = fallback;
		} else {
			if (!isUuid(toRaw)) return fail(400, { error: m.admin_categories_err_target_missing() });
			const [exists] = await db
				.select({ id: categories.id })
				.from(categories)
				.where(eq(categories.id, toRaw))
				.limit(1);
			if (!exists) return fail(404, { error: m.admin_categories_err_target_missing() });
			target = toRaw;
		}

		await db.update(posts).set({ categoryId: target }).where(inArray(posts.id, postIds));
		return { success: true, moved: postIds.length, to: target };
	},

	delete: async ({ params }) => {
		await requireAdminRole();
		if (!isUuid(params.id)) return fail(400, { error: m.admin_categories_err_missing_id() });

		// The fallback category is the safety net for every other delete; it
		// cannot itself be removed. This is an application-layer guard — the DB
		// keeps at most one default row but does not stop the DELETE.
		const [target] = await db
			.select({ isDefault: categories.isDefault })
			.from(categories)
			.where(eq(categories.id, params.id))
			.limit(1);
		if (!target) return fail(404, { error: m.admin_categories_select() });
		if (target.isDefault) return fail(409, { error: m.admin_categories_err_default_undeletable() });

		// P2 (§9.8): deleting a category that still owns posts answers 409 with
		// a readable message instead of hitting the RESTRICT FK as a 500. The
		// placeholder rows of abandoned new articles are counted separately so
		// the message can point at the drafts page (review finding).
		const [counts] = await db
			.select({
				total: sql<number>`count(*)`.mapWith(Number),
				placeholders:
					sql<number>`count(*) filter (where ${posts.version} = 0 and ${posts.status} = 'draft')`.mapWith(
						Number
					)
			})
			.from(posts)
			.where(eq(posts.categoryId, params.id));
		if ((counts?.total ?? 0) > 0) {
			const total = counts.total;
			const placeholders = counts.placeholders ?? 0;
			const error =
				placeholders === total
					? m.admin_categories_err_placeholders({ count: total })
					: m.admin_categories_err_has_posts_count({ count: total });
			return fail(409, { error });
		}

		try {
			await db.delete(categories).where(eq(categories.id, params.id));
		} catch (caught) {
			// Backstop for the count-then-delete race: the FK stays the arbiter.
			if (pgErrorCode(caught) === '23503') {
				return fail(409, { error: m.admin_categories_err_has_posts() });
			}
			throw caught;
		}

		// Back to the list: the record this page renders no longer exists.
		return { success: true, deleted: params.id };
	}
};
