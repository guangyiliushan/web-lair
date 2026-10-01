import { and, count, eq } from 'drizzle-orm';
import { getLocale } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { categories, posts } from '$lib/server/db/content';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import type { PageServerLoad } from './$types';

/**
 * Categories index (P3-b): every category that has at least one visible post
 * in the URL locale, ordered by the curated sort order. Empty categories are
 * not linked here (an index of reachable content — the category page itself
 * stays reachable by its own URL).
 */
export const load: PageServerLoad = async () => {
	const lang = getLocale();
	const now = new Date();

	const rows = await db
		.select({
			id: categories.id,
			name: categories.name,
			slug: categories.slug,
			description: categories.description,
			total: count(posts.id)
		})
		.from(categories)
		.innerJoin(
			posts,
			and(eq(posts.categoryId, categories.id), eq(posts.lang, lang), visiblePostCondition(now))
		)
		.groupBy(categories.id)
		.orderBy(categories.sortOrder, categories.name);

	return {
		categories: rows.map((row) => ({
			name: row.name,
			slug: row.slug,
			description: row.description,
			total: row.total
		}))
	};
};
