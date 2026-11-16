import { createHash } from 'node:crypto';
import { redirect } from '@sveltejs/kit';
import { and, desc, eq } from 'drizzle-orm';
import { localizeHref, locales } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import { getOption } from '$lib/server/config/options-registry';
import { db } from '$lib/server/db';
import { notes, posts } from '$lib/server/db/content';
import type { WritingOrigin } from '$lib/server/db/content/post-provenance';
import { buildRssFeed, type RssItem } from '$lib/server/feeds';
import { conditionalResponse } from '$lib/server/feeds/cache';
import { renderMarkdownToHtml } from '$lib/server/markdown';
import { getPublicOrigin } from '$lib/server/origin';
import { feedableNoteCondition } from '$lib/server/services/note-visibility';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { plainTextExcerpt } from '$lib/utils/excerpt';
import type { RequestHandler } from './$types';

const ITEM_LIMIT = 20;

/**
 * Stable English tokens for `<item><category>`, deliberately not localised: feeds
 * are consumed by software, and a category that shifts with the request locale
 * cannot be filtered on. `null` (undisclosed) emits nothing.
 */
const WRITING_CATEGORY: Record<WritingOrigin, string> = {
	none: 'No AI',
	assist: 'AI-assisted',
	mostly_ai: 'Mostly AI',
	ai_full: 'AI-generated'
};

/**
 * `/{lang}/rss.xml`; the bare root is a 302 alias to `site.default_lang` (the
 * default is configurable, so not permanent). Posts and notes share one feed: the
 * latest 20 merged, future-dated and password-gated items excluded, `urn:uuid`
 * guids so slug changes never re-deliver. Cache: strong ETag over the body; only
 * If-None-Match counts — `Last-Modified` is informational under lazy visibility.
 */
export const GET: RequestHandler = async ({ url, request }) => {
	// Not `getLocale()`: this route is excluded from the i18n route strategy.
	const locale = localeFromPath(url.pathname);
	if (!locale) {
		const defaultLang = await getOption('site.default_lang');
		redirect(302, `/${defaultLang}/rss.xml`);
	}

	const origin = getPublicOrigin() ?? url.origin;
	const now = new Date();

	// Fetch up to ITEM_LIMIT per source: the global top-N cannot need more
	// than N candidates from either one.
	const [postRows, noteRows] = await Promise.all([
		db
			.select({
				id: posts.id,
				slug: posts.slug,
				title: posts.title,
				summary: posts.summary,
				content: posts.content,
				publishedAt: posts.publishedAt,
				updatedAt: posts.updatedAt,
				writingOrigin: posts.writingOrigin
			})
			.from(posts)
			.where(and(eq(posts.lang, locale), visiblePostCondition(now)))
			.orderBy(desc(posts.publishedAt), desc(posts.id))
			.limit(ITEM_LIMIT),
		db
			.select({
				id: notes.id,
				slug: notes.slug,
				title: notes.title,
				content: notes.content,
				publishedAt: notes.publishedAt,
				updatedAt: notes.updatedAt
			})
			.from(notes)
			.where(and(eq(notes.lang, locale), feedableNoteCondition(now)))
			.orderBy(desc(notes.publishedAt), desc(notes.id))
			.limit(ITEM_LIMIT)
	]);

	// Merge BEFORE rendering: only the surviving top-N runs the markdown pipeline.
	// `sort` is stable, so equal timestamps keep a deterministic posts-then-notes
	// order and the ETag stays byte-stable. A failed render now drops that item
	// instead of backfilling from rank 21+.
	const merged = [
		...postRows.map((row) => ({ kind: 'post' as const, row })),
		...noteRows.map((row) => ({ kind: 'note' as const, row }))
	]
		.sort((a, b) => (b.row.publishedAt?.getTime() ?? 0) - (a.row.publishedAt?.getTime() ?? 0))
		.slice(0, ITEM_LIMIT);

	const items = (
		await Promise.all(
			merged.map(async ({ kind, row }): Promise<RssItem | null> => {
				// The visibility predicate already excludes unpublished rows;
				// this guard only narrows the type.
				if (!row.publishedAt) return null;
				try {
					const base = {
						title: row.title,
						guid: `urn:uuid:${row.id}`,
						pubDate: row.publishedAt,
						contentHtml: row.content ? await renderMarkdownToHtml(row.content) : undefined
					};
					if (kind === 'post') {
						const category = row.writingOrigin
							? WRITING_CATEGORY[row.writingOrigin as WritingOrigin]
							: undefined;
						return {
							...base,
							link: `${origin}${localizeHref(`/posts/${row.slug}`, { locale })}`,
							description: row.summary?.trim() || plainTextExcerpt(row.content ?? ''),
							categories: category ? [category] : undefined
						};
					}
					return {
						...base,
						link: `${origin}${localizeHref(`/notes/${row.slug}`, { locale })}`,
						description: plainTextExcerpt(row.content ?? '')
					};
				} catch (error) {
					// One broken item must not take the whole feed down: log and skip it.
					console.warn(`[rss] ${kind} item render failed`, row.id, error);
					return null;
				}
			})
		)
	).filter((item): item is RssItem => item !== null);

	let latest: Date | null = null;
	for (const row of [...postRows, ...noteRows]) {
		if (row.updatedAt && (latest === null || row.updatedAt > latest)) latest = row.updatedAt;
	}

	const body = buildRssFeed({
		lang: locale,
		title: 'Lair', // brand name — intentionally not localised (header logo)
		description: m.footer_tagline({}, { locale }),
		link: `${origin}${localizeHref('/posts', { locale })}`,
		selfHref: `${origin}${localizeHref('/rss.xml', { locale })}`,
		lastBuildDate: latest ?? undefined,
		items
	});

	const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
	return conditionalResponse(request, body, {
		contentType: 'application/rss+xml; charset=utf-8',
		etag,
		lastModified: latest
	});
};

/** First path segment when it is a locale tag (`/en/rss.xml` → `en`). */
function localeFromPath(pathname: string): (typeof locales)[number] | null {
	const first = pathname.split('/')[1] ?? '';
	return (locales as readonly string[]).includes(first)
		? (first as (typeof locales)[number])
		: null;
}
