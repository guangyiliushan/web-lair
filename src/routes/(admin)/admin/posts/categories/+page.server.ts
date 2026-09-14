import { fail } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { categories, posts } from '$lib/server/db/content';
import { getSnowflake } from '$lib/server/snowflake';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async () => {
	const allCategories = await db
		.select({
			id: categories.id,
			name: categories.name,
			slug: categories.slug,
			type: categories.type
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
		const formData = await request.formData();
		const name = formData.get('name')?.toString().trim();
		const slug = formData.get('slug')?.toString().trim().toLowerCase();

		if (!name) return fail(400, { error: '分类名称不能为空' });
		if (!slug) return fail(400, { error: 'Slug 不能为空' });

		await db.insert(categories).values({ id: getSnowflake().nextId(), name, slug, type: 0 });
		return { success: true };
	},

	update: async ({ request }) => {
		const formData = await request.formData();
		const id = formData.get('id')?.toString();
		const name = formData.get('name')?.toString().trim();
		const slug = formData.get('slug')?.toString().trim().toLowerCase();

		if (!id) return fail(400, { error: '缺少分类 ID' });
		if (!name) return fail(400, { error: '分类名称不能为空' });

		await db.update(categories).set({ name, slug }).where(eq(categories.id, id));
		return { success: true };
	},

	delete: async ({ request }) => {
		const formData = await request.formData();
		const id = formData.get('id')?.toString();
		if (!id) return fail(400, { error: '缺少分类 ID' });
		await db.delete(categories).where(eq(categories.id, id));
		return { success: true };
	}
};
