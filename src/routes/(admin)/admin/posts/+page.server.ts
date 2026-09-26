import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { categories, posts } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { draftsForPosts } from '$lib/server/services/post-drafts';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 20;
const STATUSES = ['published', 'draft', 'scheduled', 'trash'] as const;

export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();

	const statusRaw = url.searchParams.get('status') ?? '';
	const categoryRaw = url.searchParams.get('category') ?? '';
	const keyword = (url.searchParams.get('keyword') ?? '').trim();
	// Number() accepts Infinity / 1e999 and the DB offset does not (a read-only
	// probe turned ?page=Infinity into a 500; review finding).
	const rawPage = Number(url.searchParams.get('page') ?? '1');
	const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;

	// P2: the list reads the real table; a post with a pending drafts row
	// carries the "有未发布改动" badge.
	const conditions = [];
	if ((STATUSES as readonly string[]).includes(statusRaw)) {
		conditions.push(eq(posts.status, statusRaw));
	}
	if (categoryRaw && isUuid(categoryRaw)) conditions.push(eq(posts.categoryId, categoryRaw));
	if (keyword) conditions.push(ilike(posts.title, `%${keyword}%`));
	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const [rows, totals, allCategories] = await Promise.all([
		db
			.select({
				id: posts.id,
				title: posts.title,
				slug: posts.slug,
				status: posts.status,
				lang: posts.lang,
				readCount: posts.readCount,
				likeCount: posts.likeCount,
				categoryId: posts.categoryId,
				categoryName: categories.name,
				createdAt: posts.createdAt,
				updatedAt: posts.updatedAt,
				publishedAt: posts.publishedAt
			})
			.from(posts)
			.leftJoin(categories, eq(posts.categoryId, categories.id))
			.where(where)
			.orderBy(desc(posts.updatedAt))
			.limit(PAGE_SIZE)
			.offset((page - 1) * PAGE_SIZE),
		db
			.select({ count: sql<number>`count(*)`.mapWith(Number) })
			.from(posts)
			.where(where),
		db
			.select({ id: categories.id, name: categories.name, slug: categories.slug })
			.from(categories)
			.orderBy(categories.name)
	]);

	const withDrafts = await draftsForPosts(rows.map((r) => r.id));

	return {
		headerTitle: '博文',
		headerActions: [
			{ label: '分类', iconName: 'category', href: '/admin/posts/categories' },
			{ label: '标签', iconName: 'tag', href: '/admin/posts/tags' },
			{ label: '草稿箱', iconName: 'draft', href: '/admin/drafts' },
			{ label: '新建', iconName: 'plus', variant: 'default', href: '/admin/posts/edit' }
		],
		posts: rows.map((row) => ({ ...row, hasDraft: withDrafts.has(row.id) })),
		totalCount: totals[0]?.count ?? 0,
		page,
		pageSize: PAGE_SIZE,
		filters: { status: statusRaw, category: categoryRaw, keyword },
		categories: allCategories
	};
};
