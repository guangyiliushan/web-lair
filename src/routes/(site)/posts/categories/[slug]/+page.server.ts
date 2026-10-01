import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { posts, categories, postTags, tags } from '$lib/server/db/schema';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import { getLocale } from '$lib/paraglide/runtime';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { formatDate } from '$lib/utils/i18n';

export interface CategoryPostItem {
	slug: string;
	title: string;
	date: string;
	tags: string[];
}

export interface CategoryTagCount {
	name: string;
	slug: string;
	count: number;
}

export interface YearGroup {
	year: number;
	count: number;
	posts: CategoryPostItem[];
}

export const load: PageServerLoad = async ({ params }) => {
	const lang = getLocale();
	const now = new Date();

	// ── Fetch category ──
	const cat = await db.query.categories.findFirst({
		where: eq(categories.slug, params.slug)
	});

	if (!cat) throw error(404, 'Category not found');

	// ── Fetch visible posts for this locale (P3-b: locale filter + the ──
	// shared visibility predicate replace the published-only filter).
	const postRows = await db
		.select({
			id: posts.id,
			title: posts.title,
			slug: posts.slug,
			createdAt: posts.createdAt
		})
		.from(posts)
		.where(and(eq(posts.categoryId, cat.id), eq(posts.lang, lang), visiblePostCondition(now)))
		.orderBy(desc(posts.createdAt));

	// ── Tags per post (post_tags replaced the posts.tags array in P1) ──
	const postIds = postRows.map((p) => p.id);
	const tagRows = postIds.length
		? await db
				.select({ postId: postTags.postId, id: tags.id, name: tags.name, slug: tags.slug })
				.from(postTags)
				.innerJoin(tags, eq(postTags.tagId, tags.id))
				.where(inArray(postTags.postId, postIds))
		: [];
	// Keyed by tag id: same-name tags with different slugs are distinct rows
	// and must stay distinct chips (P3-b review finding). The stored slug is
	// the link identity (§9.4 allows hand-edited slugs).
	const tagMeta = new Map<string, { name: string; slug: string }>();
	const tagIdsByPost = new Map<string, string[]>();
	for (const row of tagRows) {
		const ids = tagIdsByPost.get(row.postId) ?? [];
		if (!ids.includes(row.id)) ids.push(row.id);
		tagIdsByPost.set(row.postId, ids);
		if (!tagMeta.has(row.id)) tagMeta.set(row.id, { name: row.name, slug: row.slug });
	}

	// ── Assemble posts with tags ──
	const assembled: CategoryPostItem[] = postRows.map((p) => ({
		slug: p.slug,
		title: p.title,
		date: p.createdAt ? formatDate(new Date(p.createdAt), { month: 'short', day: 'numeric' }) : '',
		tags: [...new Set((tagIdsByPost.get(p.id) ?? []).map((id) => tagMeta.get(id)!.name))]
	}));

	// ── Group by year ──
	// Year comes from the raw createdAt, not the display string: `new Date('Mar 1')`
	// silently resolves to 2001 (P1.1 review - every group showed as 2001).
	const byYear = new Map<number, CategoryPostItem[]>();
	assembled.forEach((item, index) => {
		const createdAt = postRows[index].createdAt;
		const year = createdAt ? new Date(createdAt).getFullYear() : new Date().getFullYear();
		if (!byYear.has(year)) byYear.set(year, []);
		byYear.get(year)!.push(item);
	});

	// Fallback: if no date parsed, use current year
	if (byYear.size === 0 && assembled.length > 0) {
		const year = new Date().getFullYear();
		byYear.set(year, assembled);
	}

	const sortedYears: YearGroup[] = [...byYear.entries()]
		.sort(([a], [b]) => b - a)
		.map(([year, yposts]) => ({ year, count: yposts.length, posts: yposts }));

	// ── Tag counts within this category (by tag id, see above) ──
	const tagCounts = new Map<string, number>();
	for (const ids of tagIdsByPost.values()) {
		for (const id of ids) {
			tagCounts.set(id, (tagCounts.get(id) ?? 0) + 1);
		}
	}

	const tagList: CategoryTagCount[] = [...tagCounts.entries()]
		.map(([id, count]) => ({ ...tagMeta.get(id)!, count }))
		.sort((a, b) => b.count - a.count);

	// ── Earliest year for display ──
	const earliestYear =
		postRows.length > 0
			? postRows.reduce((earliest: number, p) => {
					const y = p.createdAt ? new Date(p.createdAt).getFullYear() : new Date().getFullYear();
					return y < earliest ? y : earliest;
				}, new Date().getFullYear())
			: new Date().getFullYear();

	return {
		category: { name: cat.name, slug: cat.slug },
		totalCount: postRows.length,
		earliestYear,
		years: sortedYears,
		tags: tagList
	};
};
