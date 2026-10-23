import { error, fail } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { categories, posts } from '$lib/server/db/content';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';
import { isValidTaxonomySlug, parseTaxonomyI18n } from '$lib/server/services/taxonomy';

export const load: PageServerLoad = async ({ params }) => {
	await requireAdminRole();
	if (!isUuid(params.id)) error(404, m.admin_categories_select());

	const [category] = await db
		.select({
			id: categories.id,
			name: categories.name,
			slug: categories.slug,
			sourceLang: categories.sourceLang,
			nameI18n: categories.nameI18n
		})
		.from(categories)
		.where(eq(categories.id, params.id));
	if (!category) error(404, m.admin_categories_select());

	const related = await db
		.select({ id: posts.id, title: posts.title, status: posts.status })
		.from(posts)
		.where(eq(posts.categoryId, params.id))
		.orderBy(posts.createdAt)
		.limit(20);

	// Header actions for a selected record. Destructive work is never primary
	// (Apple HIG, Buttons), and nothing here is "Save": edits autosave.
	return {
		headerActions: [
			{
				label: m.admin_common_back_to_list(),
				iconName: 'arrow-left',
				variant: 'ghost',
				href: '/admin/posts/categories'
			},
			{
				label: m.admin_common_delete(),
				iconName: 'trash',
				variant: 'outline',
				actionId: 'categories:delete'
			}
		],
		category,
		related
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
			.set({ name, slug, nameI18n })
			.where(eq(categories.id, params.id))
			.returning({ id: categories.id });
		if (updatedRows.length === 0) return fail(404, { error: m.admin_categories_select() });
		return { success: true };
	},

	delete: async ({ params }) => {
		await requireAdminRole();
		if (!isUuid(params.id)) return fail(400, { error: m.admin_categories_err_missing_id() });

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
