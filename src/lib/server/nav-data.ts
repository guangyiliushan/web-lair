import { and, count, desc, eq } from 'drizzle-orm';
import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { categories, posts } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { countVisibleNotes, listNoteSummaries, listTopicOptions } from '$lib/server/services/notes';
import { listVisiblePages, pageHref, resolveLocalized } from '$lib/server/services/pages';
import { formatDate } from '$lib/utils/i18n';
import { noteDateLabel } from '$lib/utils/note-date';
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

	const [topics, recent, total, siteTz] = await Promise.all([
		listTopicOptions(lang, now),
		listNoteSummaries(lang, { limit: MEGA_RECENT_LIMIT, now }),
		countVisibleNotes(lang, now),
		getOption('site.timezone')
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
		desc: noteDateLabel(row.publishedAt, row.tz, siteTz),
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

	const [postRows, noteRows, siteTz] = await Promise.all([
		db
			.select({ slug: posts.slug, title: posts.title, publishedAt: posts.publishedAt })
			.from(posts)
			.where(and(eq(posts.lang, lang), visiblePostCondition(now)))
			.orderBy(desc(posts.publishedAt), desc(posts.id))
			.limit(MEGA_RECENT_LIMIT),
		listNoteSummaries(lang, { limit: MEGA_RECENT_LIMIT, now }),
		getOption('site.timezone')
	]);

	const merged = [
		...postRows.flatMap((row) =>
			row.publishedAt
				? [
						{
							title: row.title,
							href: `/posts/${row.slug}`,
							type: 'posts' as const,
							locked: false,
							tz: null,
							publishedAt: row.publishedAt
						}
					]
				: []
		),
		...noteRows.map((row) => ({
			title: row.title,
			href: `/notes/${row.slug}`,
			type: 'notes' as const,
			locked: row.locked,
			tz: row.tz,
			publishedAt: row.publishedAt
		}))
	]
		// Deterministic across equal timestamps (review finding): notes first,
		// then href - the concatenation order must not leak into the output.
		// Mirror of the timeline page tie-break ((site)/timeline/+page.server.ts).
		.sort(
			(a, b) =>
				b.publishedAt.getTime() - a.publishedAt.getTime() ||
				a.type.localeCompare(b.type) ||
				a.href.localeCompare(b.href)
		)
		.slice(0, MEGA_RECENT_LIMIT);

	const timelineItems: TimelineActivityItem[] = merged.map((item) => ({
		title: item.title,
		href: item.href,
		type: item.type,
		locked: item.locked,
		date:
			item.type === 'notes'
				? noteDateLabel(item.publishedAt, item.tz, siteTz)
				: formatDate(item.publishedAt)
	}));

	return { leftItems: [], rightItems: [], timelineItems };
}

/** Chrome payload for the pages surface: menu items + footer defaults. */
export interface PagesMegaData extends MegaMenuDynamicData {
	/** `is_default` rows (footer About group); same single query as the items. */
	footerDefaults: { label: string; href: string }[];
}

/**
 * Load data for the pages chrome (P1b): every visible row in chrome order
 * (`is_default` first → `sort_order` → `created_at`). Item titles resolve
 * through the display fallback chain, hrefs stay neutral for `siteHref`, and
 * the footer defaults ride along from the same single query (no extra
 * request). Row-level visibility (V1, 2026-10-03) - the route owns the
 * per-language availability.
 */
export async function loadPagesMegaData(): Promise<PagesMegaData> {
	const locale = getLocale();
	const rows = await listVisiblePages();

	const items: NavChild[] = rows.map((row) => ({
		label: resolveLocalized(row.title, locale) ?? row.slug,
		href: pageHref(row),
		iconName: row.icon ?? undefined
	}));

	const footerDefaults = rows
		.filter((row) => row.isDefault)
		.map((row) => ({
			label: resolveLocalized(row.title, locale) ?? row.slug,
			href: pageHref(row)
		}));

	return { leftItems: items, rightItems: [], footerDefaults };
}
