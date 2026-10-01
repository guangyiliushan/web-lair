import { createHash } from 'node:crypto';
import { localizeHref, locales } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { posts } from '$lib/server/db/content';
import { buildSitemap, type SitemapUrl } from '$lib/server/feeds';
import { getOrigin } from '$lib/server/origin';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import type { RequestHandler } from './$types';

/**
 * Single-file sitemap (P3-b, ledger §22): `/` + every visible post, each
 * language as its own <url> with published alternates (self included, slugs
 * per language). No changefreq/priority; lastmod only from a real
 * updated_at. Tags/categories stay out (thin pages) — the notes, pages,
 * projects and micro-content sources plug in here in their own batches.
 *
 * Caching (R1-Q2): strong ETag = representation hash, Last-Modified = the
 * newest included updated_at, 304 on a matching If-None-Match.
 */
export const GET: RequestHandler = async ({ request }) => {
	const origin = getOrigin();
	const now = new Date();

	const rows = await db
		.select({
			lang: posts.lang,
			slug: posts.slug,
			updatedAt: posts.updatedAt,
			translationGroup: posts.translationGroup
		})
		.from(posts)
		.where(visiblePostCondition(now));

	// Visible versions per translation group drive the alternates sets.
	const byGroup = new Map<string, { lang: string; slug: string }[]>();
	for (const row of rows) {
		const versions = byGroup.get(row.translationGroup) ?? [];
		versions.push({ lang: row.lang, slug: row.slug });
		byGroup.set(row.translationGroup, versions);
	}
	const localeOrder = locales as readonly string[];
	const alternatesOf = (groupId: string): SitemapUrl['alternates'] =>
		(byGroup.get(groupId) ?? [])
			.filter((version) => localeOrder.includes(version.lang))
			.sort((a, b) => localeOrder.indexOf(a.lang) - localeOrder.indexOf(b.lang))
			.map((version) => ({
				hreflang: version.lang,
				href: `${origin}${localizeHref(`/posts/${version.slug}`, { locale: version.lang as (typeof locales)[number] })}`
			}));

	const urls: SitemapUrl[] = [{ loc: `${origin}/` }];
	let latest: Date | null = null;
	for (const row of rows) {
		urls.push({
			loc: `${origin}${localizeHref(`/posts/${row.slug}`, { locale: row.lang as (typeof locales)[number] })}`,
			lastmod: row.updatedAt?.toISOString(),
			alternates: alternatesOf(row.translationGroup)
		});
		if (row.updatedAt && (latest === null || row.updatedAt > latest)) latest = row.updatedAt;
	}

	const body = buildSitemap({ urls });
	const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;

	const headers: Record<string, string> = {
		'content-type': 'application/xml; charset=utf-8',
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
