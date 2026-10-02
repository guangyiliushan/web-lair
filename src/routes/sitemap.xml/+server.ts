import { createHash } from 'node:crypto';
import { localizeHref, locales } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { posts } from '$lib/server/db/content';
import { buildSitemap, type SitemapUrl } from '$lib/server/feeds';
import { conditionalResponse } from '$lib/server/feeds/cache';
import { getPublicOrigin } from '$lib/server/origin';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import type { RequestHandler } from './$types';

/**
 * Single-file sitemap (P3-b, ledger §22): `/` + every visible post, each
 * language as its own <url> with published alternates (self included, slugs
 * per language). No changefreq/priority; lastmod only from a real
 * updated_at. Tags/categories stay out (thin pages), and /posts + /timeline
 * wait on a follow-up decision (registered); the notes, pages and
 * micro-content sources plug in here in their own batches.
 *
 * Ordering is pinned to (lang, slug) so the body — and therefore the strong
 * ETag — is byte-stable across requests (review finding).
 *
 * Caching (R1-Q2): strong ETag = representation hash, Last-Modified = the
 * newest included updated_at, 304 on a matching strong If-None-Match
 * (list/weak comparison per RFC 9110 §13.1.2). If-Modified-Since is
 * intentionally not evaluated — Last-Modified is informational
 * (max(updated_at) is not consistent under lazy visibility; second review
 * round 2026-10-02).
 */
export const GET: RequestHandler = async ({ request, url }) => {
	const origin = getPublicOrigin() ?? url.origin;
	const now = new Date();

	const rows = await db
		.select({
			lang: posts.lang,
			slug: posts.slug,
			updatedAt: posts.updatedAt,
			translationGroup: posts.translationGroup
		})
		.from(posts)
		.where(visiblePostCondition(now))
		.orderBy(posts.lang, posts.slug);

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
		// Unknown locales are skipped, mirroring the alternates filter above —
		// only the DB CHECK protects this otherwise (second review round).
		if (!localeOrder.includes(row.lang)) continue;
		urls.push({
			loc: `${origin}${localizeHref(`/posts/${row.slug}`, { locale: row.lang as (typeof locales)[number] })}`,
			lastmod: row.updatedAt?.toISOString(),
			alternates: alternatesOf(row.translationGroup)
		});
		if (row.updatedAt && (latest === null || row.updatedAt > latest)) latest = row.updatedAt;
	}

	const body = buildSitemap({ urls });
	const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
	return conditionalResponse(request, body, {
		contentType: 'application/xml; charset=utf-8',
		etag,
		lastModified: latest
	});
};
