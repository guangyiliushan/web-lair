import { and, count, desc, eq } from 'drizzle-orm';
import { getLocale } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { categories, posts } from '$lib/server/db/content';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { formatDate } from '$lib/utils/i18n';
import type {
	MegaMenuDynamicData,
	NavChild,
	TimelineActivityItem
} from '$lib/config/navigation.config';

const MEGA_CATEGORY_LIMIT = 5;
const MEGA_RECENT_LIMIT = 4;

/**
 * Load data for the Posts mega menu (P3-b): the locale's categories that
 * carry visible posts (curated order) plus the latest visible posts. Hrefs
 * stay neutral — the chrome renders them through `siteHref`.
 */
export async function loadPostsMegaData(): Promise<MegaMenuDynamicData> {
	const lang = getLocale();
	const now = new Date();

	const [categoryRows, recentRows, totalRows] = await Promise.all([
		db
			.select({ name: categories.name, slug: categories.slug, total: count(posts.id) })
			.from(categories)
			.innerJoin(
				posts,
				and(eq(posts.categoryId, categories.id), eq(posts.lang, lang), visiblePostCondition(now))
			)
			.groupBy(categories.id)
			.orderBy(categories.sortOrder, categories.name)
			.limit(MEGA_CATEGORY_LIMIT),
		db
			.select({ slug: posts.slug, title: posts.title, publishedAt: posts.publishedAt })
			.from(posts)
			.where(and(eq(posts.lang, lang), visiblePostCondition(now)))
			.orderBy(desc(posts.publishedAt))
			.limit(MEGA_RECENT_LIMIT),
		db
			.select({ total: count() })
			.from(posts)
			.where(and(eq(posts.lang, lang), visiblePostCondition(now)))
	]);

	const leftItems: NavChild[] = categoryRows.map((row) => ({
		label: row.name,
		href: `/posts/categories/${row.slug}`,
		badge: row.total
	}));

	const rightItems: NavChild[] = recentRows.flatMap((row) =>
		row.publishedAt
			? [
					{
						label: row.title,
						href: `/posts/${row.slug}`,
						desc: formatDate(row.publishedAt)
					}
				]
			: []
	);

	const total = totalRows[0]?.total ?? 0;

	return { leftItems, rightItems, footerSecondaryText: `${total} posts` };
}

/**
 * Load data for the Notes mega menu.
 * N1 (notes behavior batch) replaces the placeholder with real queries.
 */
export async function loadNotesMegaData(): Promise<MegaMenuDynamicData> {
	// TODO: Replace with actual database queries (N1)

	const leftItems: NavChild[] = [
		{
			label: 'Year End Review',
			href: '/notes/series/year-summary',
			imageUrl: 'https://placehold.co/32x32/6366f1/white?text=Y'
		},
		{
			label: 'Memories — Shanghai',
			href: '/notes/series/shanghai',
			imageUrl: 'https://placehold.co/32x32/f59e0b/white?text=S'
		},
		{
			label: 'Late Night Emo',
			href: '/notes/series/emo',
			imageUrl: 'https://placehold.co/32x32/8b5cf6/white?text=E'
		},
		{
			label: 'Phase Summary',
			href: '/notes/series/stage-summary',
			imageUrl: 'https://placehold.co/32x32/10b981/white?text=P'
		},
		{
			label: 'Morning Flowers, Evening Picks',
			href: '/notes/series/morning-glory',
			imageUrl: 'https://placehold.co/32x32/ec4899/white?text=M'
		},
		{
			label: 'Current Update',
			href: '/notes/series/recent',
			imageUrl: 'https://placehold.co/32x32/06b6d4/white?text=C'
		},
		{
			label: 'Travel Notes',
			href: '/notes/series/tour',
			imageUrl: 'https://placehold.co/32x32/f97316/white?text=T'
		}
	];

	const rightItems: NavChild[] = [
		{
			label: 'First Time in Tokyo: A Trip 26 Years in the Making',
			href: '/notes/1',
			desc: '11 days ago'
		},
		{
			label: 'When Life Is Consumed by AI, I Start Reflecting on Loneliness and Love',
			href: '/notes/2',
			desc: 'Tuesday, May 26, 2026'
		},
		{
			label: 'Code & Dopamine: My Month of AI-Powered Creation',
			href: '/notes/3',
			desc: 'Wednesday, May 6, 2026'
		},
		{ label: 'A Child Who Never Grew Up', href: '/notes/4', desc: 'Monday, April 20, 2026' }
	];

	return { leftItems, rightItems };
}

/**
 * Load data for the Timeline mega menu (P3-b): the latest visible posts as
 * activity entries — notes join the stream with N1 (`/timeline?type=note`
 * lands there too).
 */
export async function loadTimelineMegaData(): Promise<MegaMenuDynamicData> {
	const lang = getLocale();
	const now = new Date();

	const rows = await db
		.select({ slug: posts.slug, title: posts.title, publishedAt: posts.publishedAt })
		.from(posts)
		.where(and(eq(posts.lang, lang), visiblePostCondition(now)))
		.orderBy(desc(posts.publishedAt))
		.limit(MEGA_RECENT_LIMIT);

	const timelineItems: TimelineActivityItem[] = rows.flatMap((row) =>
		row.publishedAt
			? [
					{
						title: row.title,
						href: `/posts/${row.slug}`,
						type: 'posts' as const,
						date: formatDate(row.publishedAt)
					}
				]
			: []
	);

	return { leftItems: [], rightItems: [], timelineItems };
}
