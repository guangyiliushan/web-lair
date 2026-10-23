import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { categories, posts } from '$lib/server/db/content';
import { sql } from 'drizzle-orm';
import type { LayoutServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * The list is layout-level: both `/categories` and `/categories/[id]` render
 * the list pane, so they share one load. SvelteKit only re-runs this when a
 * value it actually read changes — it reads no `url`/`params` — so selecting
 * a row does not refetch the list.
 */
export const load: LayoutServerLoad = async () => {
	await requireAdminRole();

	const allCategories = await db
		.select({ id: categories.id, name: categories.name, slug: categories.slug })
		.from(categories)
		.orderBy(categories.name);

	const rows = await db
		.select({
			categoryId: posts.categoryId,
			count: sql<number>`count(${posts.id})`.mapWith(Number)
		})
		.from(posts)
		.groupBy(posts.categoryId);

	const postCounts: Record<string, number> = {};
	for (const r of rows) postCounts[r.categoryId] = r.count;

	return {
		headerTitle: m.nav_posts_categories(),
		categories: allCategories,
		postCounts
	};
};
