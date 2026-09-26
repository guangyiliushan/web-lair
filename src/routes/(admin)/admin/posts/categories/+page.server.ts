import { fail } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { categories, posts } from '$lib/server/db/content';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async () => {
	const allCategories = await db
		.select({
			id: categories.id,
			name: categories.name,
			slug: categories.slug
		})
		.from(categories)
		.orderBy(categories.name);

	// Count posts per category
	const rows = await db
		.select({
			categoryId: posts.categoryId,
			count: sql<number>`count(${posts.id})`.mapWith(Number)
		})
		.from(posts)
		.groupBy(posts.categoryId);

	const postCounts: Record<string, number> = {};
	for (const r of rows) {
		postCounts[r.categoryId] = r.count;
	}

	return { headerTitle: '分类', categories: allCategories, postCounts };
};

export const actions: Actions = {
	create: async ({ request }) => {
		await requireAdminRole();
		const formData = await request.formData();
		const name = formData.get('name')?.toString().trim();
		const slug = formData.get('slug')?.toString().trim().toLowerCase();

		if (!name) return fail(400, { error: '分类名称不能为空' });
		if (!slug) return fail(400, { error: 'Slug 不能为空' });

		await db.insert(categories).values({ name, slug });
		return { success: true };
	},

	update: async ({ request }) => {
		await requireAdminRole();
		const formData = await request.formData();
		const id = formData.get('id')?.toString();
		const name = formData.get('name')?.toString().trim();
		const slug = formData.get('slug')?.toString().trim().toLowerCase();

		if (!id || !isUuid(id)) return fail(400, { error: '缺少分类 ID' });
		if (!name) return fail(400, { error: '分类名称不能为空' });

		await db.update(categories).set({ name, slug }).where(eq(categories.id, id));
		return { success: true };
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const formData = await request.formData();
		const id = formData.get('id')?.toString();
		if (!id || !isUuid(id)) return fail(400, { error: '缺少分类 ID' });

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
			.where(eq(posts.categoryId, id));
		if ((counts?.total ?? 0) > 0) {
			const total = counts.total;
			const placeholders = counts.placeholders ?? 0;
			const error =
				placeholders === total
					? `该分类下仅有 ${total} 个未发布的新建占位，请先在草稿箱丢弃后再删除`
					: `该分类下仍有 ${total} 篇文章，无法删除`;
			return fail(409, { error });
		}

		try {
			await db.delete(categories).where(eq(categories.id, id));
		} catch (caught) {
			// Backstop for the count-then-delete race: the FK stays the arbiter.
			if (pgErrorCode(caught) === '23503') {
				return fail(409, { error: '该分类下仍有文章，无法删除' });
			}
			throw caught;
		}
		return { success: true };
	}
};
