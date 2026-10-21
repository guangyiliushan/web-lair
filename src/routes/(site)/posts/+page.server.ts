import { and, count, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { getLocale } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { categories, postTags, posts, tags } from '$lib/server/db/content';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { plainTextExcerpt } from '$lib/utils/excerpt';
import { formatDate } from '$lib/utils/i18n';
import {
	POSTS_PAGE_SIZE,
	parsePostAiFilter,
	parsePostSort,
	type PostSort
} from '$lib/utils/posts-list';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = POSTS_PAGE_SIZE;

/**
 * Public posts list (P3-a read side, ledger §9.18): posts of the URL locale
 * only, filtered by the shared visibility condition. `sort` is additive:
 * latest keeps editorial pinning first; oldest/updated honour the chosen
 * order strictly (a pin never jumps the queue). Every ordering ends with an
 * id tie-break so pagination cannot shuffle tied rows.
 */
const ORDER_BY = {
	oldest: [sql`${posts.publishedAt} asc nulls last`, sql`${posts.id} asc`],
	// updated_at is nullable in the baseline; DESC defaults to NULLS FIRST.
	updated: [sql`${posts.updatedAt} desc nulls last`, sql`${posts.id} desc`],
	latest: [
		sql`${posts.pinAt} desc nulls last`,
		sql`${posts.publishedAt} desc nulls last`,
		sql`${posts.id} desc`
	]
} satisfies Record<PostSort, SQL[]>;

export const load: PageServerLoad = async ({ url }) => {
	const lang = getLocale();
	const sort = parsePostSort(url.searchParams.get('sort'));
	const ai = parsePostAiFilter(url.searchParams.get('ai'));
	// Any sort/filter parameter — including ?sort=latest and junk values — is a
	// non-canonical view. noindex bounds that URL space; the page emits no
	// canonical for these variants because page N sorted/filtered ≠ page N default.
	const isSortVariant = url.searchParams.has('sort');
	const isAiVariant = url.searchParams.has('ai');
	const isVariant = isSortVariant || isAiVariant;
	// Translations carry the source's writing claim, so a NULL own axis on a
	// translation that points at a non-generated source still qualifies.
	const nonGeneratedSourceIds = db
		.select({ id: posts.id })
		.from(posts)
		.where(inArray(posts.writingOrigin, ['none', 'assist']));
	const filterCondition = ai
		? or(
				inArray(posts.writingOrigin, ['none', 'assist']),
				and(isNull(posts.writingOrigin), inArray(posts.translatedFromPostId, nonGeneratedSourceIds))
			)
		: undefined;
	const visible = and(eq(posts.lang, lang), visiblePostCondition(), filterCondition);

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
			updatedAt: posts.updatedAt,
			pinAt: posts.pinAt,
			readCount: posts.readCount,
			likeCount: posts.likeCount,
			categoryName: categories.name
		})
		.from(posts)
		.innerJoin(categories, eq(posts.categoryId, categories.id))
		.where(visible)
		// Every ordering ends with an id tie-break: the only paginated read
		// must not shuffle tied rows across pages.
		.orderBy(...ORDER_BY[sort])
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
		updatedDate: row.updatedAt ? formatDate(row.updatedAt) : '',
		category: row.categoryName,
		tags: [...new Set(tagsByPost.get(row.id) ?? [])],
		views: row.readCount,
		likes: row.likeCount,
		edited:
			row.updatedAt != null &&
			row.publishedAt != null &&
			row.updatedAt.getTime() - row.publishedAt.getTime() > 60_000,
		pinned: row.pinAt !== null
	});

	// The dedicated pinned card is a latest-only, first-page affordance. For
	// oldest/updated the pin must not jump the queue: the row is rendered in
	// place with a badge instead.
	const pinnedRow =
		sort === 'latest' && page === 1 ? rows.find((row) => row.pinAt !== null) : undefined;

	return {
		pinnedPost: pinnedRow ? toCard(pinnedRow) : null,
		posts: rows.filter((row) => row !== pinnedRow).map(toCard),
		total,
		totalPages,
		page,
		pageSize: POSTS_PAGE_SIZE,
		sort,
		ai,
		isSortVariant,
		isAiVariant,
		isVariant
	};
};
