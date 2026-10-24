import { and, count, desc, eq } from 'drizzle-orm';
import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { categories, posts } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { countVisibleNotes, listNoteSummaries, listTopicOptions } from '$lib/server/services/notes';
import { listVisiblePages, pageHref, resolveLocalized } from '$lib/server/services/pages';
import { resolveTaxonomyName } from '$lib/server/services/taxonomy';
import { formatNavDate } from '$lib/utils/i18n';
import { noteDisplayTimeZone } from '$lib/utils/note-date';
import type { NavChild, NavMenuData, PagesMegaData } from '$lib/config/navigation.config';

const MEGA_CATEGORY_LIMIT = 4;
const MEGA_RECENT_LIMIT = 4;
const MEGA_TOPIC_LIMIT = 4;

/**
 * Load data for the Posts mega menu (P3-b): the locale's categories that
 * carry visible posts (curated order) plus the latest visible posts. Hrefs
 * stay neutral - the chrome renders them through `siteHref`.
 */
export async function loadPostsMegaData(): Promise<NavMenuData> {
	const lang = getLocale();
	const now = new Date();

	// Two queries (second review round): the unfiltered category aggregate
	// doubles as the locale total - every visible post has exactly one
	// category (`category_id NOT NULL`, FK-restricted), so the dedicated
	// COUNT query was redundant.
	const [categoryRows, recentRows] = await Promise.all([
		db
			.select({
				name: categories.name,
				nameI18n: categories.nameI18n,
				sourceLang: categories.sourceLang,
				slug: categories.slug,
				total: count(posts.id)
			})
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
		label: resolveTaxonomyName(row, lang),
		href: `/posts/categories/${row.slug}`,
		badge: row.total
	}));

	const rightItems: NavChild[] = recentRows.flatMap((row) =>
		row.publishedAt
			? [
					{
						label: row.title,
						href: `/posts/${row.slug}`,
						// The panel's date column is 44px wide — long-form dates
						// would blow past it in every locale.
						desc: formatNavDate(row.publishedAt)
					}
				]
			: []
	);

	const total = categoryRows.reduce((sum, row) => sum + row.total, 0);

	return {
		leftItems,
		rightItems,
		footerSecondaryText: m.nav_posts_count({ count: total }),
		// Same aggregate the footer already uses — no extra query.
		stats: { posts: total }
	};
}

/**
 * Load data for the Notes mega menu (N1): the locale's topics that carry
 * visible notes (curated order, icon names resolved client-side) plus the
 * latest visible notes - gated rows included, flagged with `locked` (the
 * list contract shows title + lock).
 */
export async function loadNotesMegaData(): Promise<NavMenuData> {
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
		// Same timezone resolution as `noteDateLabel`, so a note cannot show a
		// different day here than it does on the list page.
		desc: formatNavDate(row.publishedAt, { timeZone: noteDisplayTimeZone(row.tz, siteTz) }),
		locked: row.locked
	}));

	return {
		leftItems,
		rightItems,
		footerSecondaryText: m.notes_count({ count: total }),
		// Both numbers are already in hand from the same two queries.
		stats: { notes: total, topics: topics.length }
	};
}

/**
 * Load data for the Timeline mega menu (P3-b + N1): the latest visible
 * entries across posts and notes merged into one stream, newest first.
 */
export async function loadTimelineMegaData(): Promise<NavMenuData> {
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

	// The timeline panel is the same two-column layout as posts/notes, so
	// activity rows ride as ordinary `NavChild`s: `desc` is the compact
	// date and `badge` carries the kind (the right-hand row renders it).
	const kindLabel = {
		posts: m.nav_timeline_posts(),
		notes: m.nav_timeline_notes(),
		memories: m.nav_timeline_memories()
	} as const;

	const rightItems: NavChild[] = merged.map((item) => ({
		label: item.title,
		href: item.href,
		desc: formatNavDate(
			item.publishedAt,
			item.type === 'notes' ? { timeZone: noteDisplayTimeZone(item.tz, siteTz) } : undefined
		),
		locked: item.locked,
		badge: kindLabel[item.type]
	}));

	return { leftItems: [], rightItems };
}

/**
 * Load data for the pages chrome (P1b): every visible row in chrome order
 * (`is_default` first → `sort_order` → `created_at`). Item titles resolve
 * through the display fallback chain, hrefs stay neutral for `siteHref`, and
 * the footer defaults ride along from the same single query (no extra
 * request). Row-level visibility (V1, 2026-10-03) - the route owns the
 * per-language availability.
 *
 * Stat counts are not read here: the sibling loaders already hold them and the
 * layout merges the partials into `stats`, so this stays a single-query loader
 * that runs in parallel with the rest.
 */
export async function loadPagesMegaData(): Promise<PagesMegaData> {
	const locale = getLocale();
	const rows = await listVisiblePages();

	const items: NavChild[] = rows.map((row) => ({
		label: resolveLocalized(row.title, locale) ?? row.slug,
		href: pageHref(row),
		key: row.slug,
		iconName: row.icon ?? undefined
	}));

	const footerDefaults = rows
		.filter((row) => row.isDefault)
		.map((row) => ({
			label: resolveLocalized(row.title, locale) ?? row.slug,
			href: pageHref(row),
			key: row.slug
		}));

	return { leftItems: items, rightItems: [], footerDefaults };
}
