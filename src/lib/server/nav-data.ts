import { and, count, desc, eq } from 'drizzle-orm';
import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { categories, posts } from '$lib/server/db/content';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { countVisibleNotes, listNoteSummaries, listTopicOptions } from '$lib/server/services/notes';
import { formatDate } from '$lib/utils/i18n';
import type {
	MegaMenuDynamicData,
	NavChild,
	TimelineActivityItem
} from '$lib/config/navigation.config';

const MEGA_CATEGORY_LIMIT = 5;
const MEGA_RECENT_LIMIT = 4;
const MEGA_TOPIC_LIMIT = 5;

/**
 * Load data for the Posts mega menu (P3-b): the locale's categories that
 * carry visible posts (curated order) plus the latest visible posts. Hrefs
 * stay neutral - the chrome renders them through `siteHref`.
 */
export async function loadPostsMegaData(): Promise<MegaMenuDynamicData> {
	const lang = getLocale();
	const now = new Date();

	// Two queries (second review round): the unfiltered category aggregate
	// doubles as the locale total - every visible post has exactly one
	// category (`category_id NOT NULL`, FK-restricted), so the dedicated
	// COUNT query was redundant.
	const [categoryRows, recentRows] = await Promise.all([
		db
			.select({ name: categories.name, slug: categories.slug, total: count(posts.id) })
			.from(categories)
			.innerJoin(
				posts,
				and(eq(posts.categoryId, categories.id), eq(posts.lang, lang), visiblePostCondition(now))
			)
			.groupBy(categories.id)
			.orderBy(categories.sortOrder, categories.name),
		db
			.select({ slug: posts.slug, title: posts.title, publishedAt: posts.publishedAt })
			.from(posts)
			.where(and(eq(posts.lang, lang), visiblePostCondition(now)))
			.orderBy(desc(posts.publishedAt), desc(posts.id))
			.limit(MEGA_RECENT_LIMIT)
	]);

	const leftItems: NavChild[] = categoryRows.slice(0, MEGA_CATEGORY_LIMIT).map((row) => ({
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

	const total = categoryRows.reduce((sum, row) => sum + row.total, 0);

	return { leftItems, rightItems, footerSecondaryText: m.nav_posts_count({ count: total }) };
}

/**
 * Load data for the Notes mega menu (N1): the locale's topics that carry
 * visible notes (curated order, icon names resolved client-side) plus the
 * latest visible notes - gated rows included, flagged with `locked` (the
 * list contract shows title + lock).
 */
export async function loadNotesMegaData(): Promise<MegaMenuDynamicData> {
	const lang = getLocale();
	const now = new Date();

	const [topics, recent, total] = await Promise.all([
		listTopicOptions(lang, now),
		listNoteSummaries(lang, { limit: MEGA_RECENT_LIMIT, now }),
		countVisibleNotes(lang, now)
	]);

	const leftItems: NavChild[] = topics.slice(0, MEGA_TOPIC_LIMIT).map((row) => ({
		label: row.name,
		href: `/notes/topics/${row.slug}`,
		iconName: row.icon ?? undefined,
		badge: row.total
	}));

	const rightItems: NavChild[] = recent.map((row) => ({
		label: row.title,
		href: `/notes/${row.slug}`,
		desc: formatDate(row.publishedAt, row.tz ? { timeZone: row.tz } : undefined),
		locked: row.locked
	}));

	return { leftItems, rightItems, footerSecondaryText: m.notes_count({ count: total }) };
}

/**
 * Load data for the Timeline mega menu (P3-b + N1): the latest visible
 * entries across posts and notes merged into one stream, newest first.
 */
export async function loadTimelineMegaData(): Promise<MegaMenuDynamicData> {
	const lang = getLocale();
	const now = new Date();

	const [postRows, noteRows] = await Promise.all([
		db
			.select({ slug: posts.slug, title: posts.title, publishedAt: posts.publishedAt })
			.from(posts)
			.where(and(eq(posts.lang, lang), visiblePostCondition(now)))
			.orderBy(desc(posts.publishedAt), desc(posts.id))
			.limit(MEGA_RECENT_LIMIT),
		listNoteSummaries(lang, { limit: MEGA_RECENT_LIMIT, now })
	]);

	const merged = [
		...postRows.flatMap((row) =>
			row.publishedAt
				? [
						{
							title: row.title,
							href: `/posts/${row.slug}`,
							type: 'posts' as const,
							publishedAt: row.publishedAt
						}
					]
				: []
		),
		...noteRows.map((row) => ({
			title: row.title,
			href: `/notes/${row.slug}`,
			type: 'notes' as const,
			publishedAt: row.publishedAt
		}))
	]
		.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
		.slice(0, MEGA_RECENT_LIMIT);

	const timelineItems: TimelineActivityItem[] = merged.map((item) => ({
		title: item.title,
		href: item.href,
		type: item.type,
		date: formatDate(item.publishedAt)
	}));

	return { leftItems: [], rightItems: [], timelineItems };
}
