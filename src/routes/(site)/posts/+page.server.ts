import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { getLocale } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { categories, postTags, posts, tags } from '$lib/server/db/content';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { plainTextExcerpt } from '$lib/utils/excerpt';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 10;

/**
 * Public posts list (P3-a minimal read side, ledger §9.18): posts of the URL
 * locale only, filtered by the shared visibility condition, pinned first.
 * Sorting, filters and aggregates (categories/tags/timeline) are P3-b.
 */
export const load: PageServerLoad = async ({ url }) => {
	const lang = getLocale();
	const visible = and(eq(posts.lang, lang), visiblePostCondition());

	const [totals] = await db.select({ total: count() }).from(posts).where(visible);
	const total = totals?.total ?? 0;
	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const requested = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
	const page = Math.min(Math.max(Number.isNaN(requested) ? 1 : requested, 1), totalPages);

	const rows = await db
		.select({
			id: posts.id,
			slug: posts.slug,
			title: posts.title,
			summary: posts.summary,
			content: posts.content,
			publishedAt: posts.publishedAt,
			pinAt: posts.pinAt,
			readCount: posts.readCount,
			likeCount: posts.likeCount,
			categoryName: categories.name
		})
		.from(posts)
		.innerJoin(categories, eq(posts.categoryId, categories.id))
		.where(visible)
		// id tiebreak (review round 2): the only paginated read must not
		// shuffle tied rows across pages.
		.orderBy(
			sql`${posts.pinAt} desc nulls last`,
			sql`${posts.publishedAt} desc nulls last`,
			sql`${posts.id} desc`
		)
		.limit(PAGE_SIZE)
		.offset((page - 1) * PAGE_SIZE);

	const ids = rows.map((row) => row.id);
	const tagRows = ids.length
		? await db
				.select({ postId: postTags.postId, name: tags.name })
				.from(postTags)
				.innerJoin(tags, eq(postTags.tagId, tags.id))
				.where(inArray(postTags.postId, ids))
				.orderBy(tags.name)
		: [];
	const tagsByPost = new Map<string, string[]>();
	for (const row of tagRows) {
		const list = tagsByPost.get(row.postId) ?? [];
		list.push(row.name);
		tagsByPost.set(row.postId, list);
	}

	const toCard = (row: (typeof rows)[number]) => ({
		slug: row.slug,
		title: row.title,
		excerpt: row.summary?.trim() || plainTextExcerpt(row.content ?? ''),
		date: row.publishedAt ? formatDate(row.publishedAt) : '',
		category: row.categoryName,
		tags: tagsByPost.get(row.id) ?? [],
		views: row.readCount,
		likes: row.likeCount
	});

	// The pinned card only exists on the first page — the ordering already
	// puts pinned rows (pin_at not null) ahead of everything else.
	const pinnedRow = page === 1 ? rows.find((row) => row.pinAt !== null) : undefined;

	return {
		pinnedPost: pinnedRow ? toCard(pinnedRow) : null,
		posts: rows.filter((row) => row !== pinnedRow).map(toCard),
		total,
		totalPages,
		page
	};
};
