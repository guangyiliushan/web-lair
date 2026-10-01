import { createHash } from 'node:crypto';
import { redirect } from '@sveltejs/kit';
import { and, desc, eq } from 'drizzle-orm';
import { localizeHref, locales } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import { getOption } from '$lib/server/config/options-registry';
import { db } from '$lib/server/db';
import { posts } from '$lib/server/db/content';
import { buildRssFeed, type RssItem } from '$lib/server/feeds';
import { renderMarkdownToHtml } from '$lib/server/markdown';
import { getOrigin } from '$lib/server/origin';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { plainTextExcerpt } from '$lib/utils/excerpt';
import type { RequestHandler } from './$types';

const ITEM_LIMIT = 20;

/**
 * Per-language feeds live inside the language segment (`/{lang}/rss.xml`);
 * the bare root path is only an alias pointing at the default-language feed
 * with a temporary redirect (R1-Q3: `site.default_lang` is configurable, so
 * a permanent redirect would cache a stale target).
 *
 * Scope (ledger §22): posts — notes join with N1 — latest 20, future-dated
 * items excluded by the shared visibility predicate, `urn:uuid` guids so
 * slug changes never re-deliver an item. Caching (R1-Q2): strong ETag =
 * representation hash + Last-Modified from the newest updated_at.
 */
export const GET: RequestHandler = async ({ url, request }) => {
	const locale = localeFromPath(url.pathname);
	if (!locale) {
		const defaultLang = await getOption('site.default_lang');
		redirect(302, `/${defaultLang}/rss.xml`);
	}

	const origin = getOrigin();
	const now = new Date();

	const rows = await db
		.select({
			id: posts.id,
			slug: posts.slug,
			title: posts.title,
			summary: posts.summary,
			content: posts.content,
			publishedAt: posts.publishedAt,
			updatedAt: posts.updatedAt
		})
		.from(posts)
		.where(and(eq(posts.lang, locale), visiblePostCondition(now)))
		.orderBy(desc(posts.publishedAt))
		.limit(ITEM_LIMIT);

	const items = (
		await Promise.all(
			rows.map(async (row): Promise<RssItem | null> => {
				// The visibility predicate already excludes unpublished rows;
				// this guard only narrows the type.
				if (!row.publishedAt) return null;
				return {
					title: row.title,
					link: `${origin}${localizeHref(`/posts/${row.slug}`, { locale })}`,
					guid: `urn:uuid:${row.id}`,
					pubDate: row.publishedAt,
					description: row.summary?.trim() || plainTextExcerpt(row.content ?? ''),
					contentHtml: row.content ? await renderMarkdownToHtml(row.content) : undefined
				};
			})
		)
	).filter((item): item is RssItem => item !== null);

	let latest: Date | null = null;
	for (const row of rows) {
		if (row.updatedAt && (latest === null || row.updatedAt > latest)) latest = row.updatedAt;
	}

	const body = buildRssFeed({
		lang: locale,
		title: 'Lair',
		description: m.footer_tagline({}, { locale }),
		link: `${origin}${localizeHref('/posts', { locale })}`,
		selfHref: `${origin}${localizeHref('/rss.xml', { locale })}`,
		lastBuildDate: latest ?? undefined,
		items
	});

	const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
	const headers: Record<string, string> = {
		'content-type': 'application/rss+xml; charset=utf-8',
		'cache-control': 'public, max-age=300',
		etag
	};
	if (latest) headers['last-modified'] = latest.toUTCString();

	const ifNoneMatch = request.headers.get('if-none-match');
	if (ifNoneMatch === etag || ifNoneMatch === '*') {
		return new Response(null, { status: 304, headers });
	}
	return new Response(body, { status: 200, headers });
};

/** First path segment when it is a locale tag (`/en/rss.xml` → `en`). */
function localeFromPath(pathname: string): (typeof locales)[number] | null {
	const first = pathname.split('/')[1] ?? '';
	return (locales as readonly string[]).includes(first)
		? (first as (typeof locales)[number])
		: null;
}
