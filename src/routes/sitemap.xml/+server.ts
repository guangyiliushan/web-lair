import { createHash } from 'node:crypto';
import { asc } from 'drizzle-orm';
import { localizeHref, locales } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { notes, posts, topics } from '$lib/server/db/content';
import { buildSitemap, type SitemapUrl } from '$lib/server/feeds';
import { conditionalResponse } from '$lib/server/feeds/cache';
import { getPublicOrigin } from '$lib/server/origin';
import { feedableNoteCondition } from '$lib/server/services/note-visibility';
import { contentLocales, listSitemapPages } from '$lib/server/services/pages';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import type { RequestHandler } from './$types';

/**
 * Single-file sitemap (P3-b, ledger §22; notes + topics joined in the N1
 * seam): `/` + every visible post + every feedable note (visible AND not
 * password-gated - notes plan §3.3 exclusion face) + every topic page, each
 * language as its own <url>. Post/note alternates come from the published
 * versions of their translation group (self included, slugs per language);
 * topic pages are entity pages, so their alternates mirror SeoHead's
 * same-path-per-locale default. No changefreq/priority; lastmod only from a
 * real updated_at (topics carry no timestamp column). Tags/categories stay
 * out (thin pages) and /posts + /timeline wait on a follow-up decision
 * (registered); the micro-content source plugs in here in its own batch (the
 * pages source joined in P1b, 2026-10-03).
 *
 * Ordering is pinned (posts by lang/slug, then notes by lang/slug, then
 * topics by slug with locales in a fixed order, then pages by slug with their
 * content locales in fixed order) so the body - and therefore
 * the strong ETag - is byte-stable across requests (review finding).
 *
 * Caching (R1-Q2): strong ETag = representation hash, Last-Modified = the
 * newest included updated_at, 304 on a matching strong If-None-Match
 * (list/weak comparison per RFC 9110 §13.1.2). If-Modified-Since is
 * intentionally not evaluated - Last-Modified is informational
 * (max(updated_at) is not consistent under lazy visibility; second review
 * round 2026-10-02).
 */
export const GET: RequestHandler = async ({ request, url }) => {
	const origin = getPublicOrigin() ?? url.origin;
	const now = new Date();

	const [postRows, noteRows, topicRows, pageRows] = await Promise.all([
		db
			.select({
				lang: posts.lang,
				slug: posts.slug,
				updatedAt: posts.updatedAt,
				translationGroup: posts.translationGroup
			})
			.from(posts)
			.where(visiblePostCondition(now))
			.orderBy(posts.lang, posts.slug),
		db
			.select({
				lang: notes.lang,
				slug: notes.slug,
				updatedAt: notes.updatedAt,
				translationGroup: notes.translationGroup
			})
			.from(notes)
			.where(feedableNoteCondition(now))
			.orderBy(notes.lang, notes.slug),
		db.select({ slug: topics.slug }).from(topics).orderBy(asc(topics.slug)),
		listSitemapPages()
	]);

	const localeOrder = locales as readonly string[];

	/** Published versions per translation group drive the alternates sets. */
	function alternatesOf(
		rows: { lang: string; slug: string; translationGroup: string }[],
		pathFor: (slug: string) => string
	): Map<string, SitemapUrl['alternates']> {
		const byGroup = new Map<string, { lang: string; slug: string }[]>();
		for (const row of rows) {
			const versions = byGroup.get(row.translationGroup) ?? [];
			versions.push({ lang: row.lang, slug: row.slug });
			byGroup.set(row.translationGroup, versions);
		}
		const result = new Map<string, SitemapUrl['alternates']>();
		for (const [groupId, versions] of byGroup) {
			result.set(
				groupId,
				versions
					.filter((version) => localeOrder.includes(version.lang))
					.sort((a, b) => localeOrder.indexOf(a.lang) - localeOrder.indexOf(b.lang))
					.map((version) => ({
						hreflang: version.lang,
						href: `${origin}${localizeHref(pathFor(version.slug), {
							locale: version.lang as (typeof locales)[number]
						})}`
					}))
			);
		}
		return result;
	}

	const postAlternates = alternatesOf(postRows, (slug) => `/posts/${slug}`);
	const noteAlternates = alternatesOf(noteRows, (slug) => `/notes/${slug}`);

	const urls: SitemapUrl[] = [{ loc: `${origin}/` }];
	let latest: Date | null = null;

	for (const row of postRows) {
		// Unknown locales are skipped, mirroring the alternates filter above -
		// only the DB CHECK protects this otherwise (second review round).
		if (!localeOrder.includes(row.lang)) continue;
		urls.push({
			loc: `${origin}${localizeHref(`/posts/${row.slug}`, { locale: row.lang as (typeof locales)[number] })}`,
			lastmod: row.updatedAt?.toISOString(),
			alternates: postAlternates.get(row.translationGroup)
		});
		if (row.updatedAt && (latest === null || row.updatedAt > latest)) latest = row.updatedAt;
	}

	for (const row of noteRows) {
		if (!localeOrder.includes(row.lang)) continue;
		urls.push({
			loc: `${origin}${localizeHref(`/notes/${row.slug}`, { locale: row.lang as (typeof locales)[number] })}`,
			lastmod: row.updatedAt?.toISOString(),
			alternates: noteAlternates.get(row.translationGroup)
		});
		if (row.updatedAt && (latest === null || row.updatedAt > latest)) latest = row.updatedAt;
	}

	for (const topic of topicRows) {
		const topicPath = `/notes/topics/${topic.slug}`;
		// Entity pages: SeoHead defaults every locale to the same path, so the
		// sitemap mirrors that with a same-path alternate set per locale.
		const alternates = localeOrder.map((lang) => ({
			hreflang: lang,
			href: `${origin}${localizeHref(topicPath, { locale: lang as (typeof locales)[number] })}`
		}));
		for (const lang of localeOrder) {
			urls.push({
				loc: `${origin}${localizeHref(topicPath, { locale: lang as (typeof locales)[number] })}`,
				alternates
			});
		}
	}

	// Pages source (P1b, 2026-10-03 ruling): one <loc> per content locale with
	// a same-path alternate set (self included) - mirrors the route's hreflang
	// exactly. Slug order + fixed locale order keep the body byte-stable.
	for (const row of pageRows) {
		const pagePath = `/${row.slug}`;
		const pageLocales = contentLocales(row.content);
		const alternates = pageLocales.map((lang) => ({
			hreflang: lang,
			href: `${origin}${localizeHref(pagePath, { locale: lang as (typeof locales)[number] })}`
		}));
		for (const lang of pageLocales) {
			urls.push({
				loc: `${origin}${localizeHref(pagePath, { locale: lang as (typeof locales)[number] })}`,
				lastmod: row.updatedAt.toISOString(),
				alternates
			});
		}
		if (latest === null || row.updatedAt > latest) latest = row.updatedAt;
	}

	const body = buildSitemap({ urls });
	const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
	return conditionalResponse(request, body, {
		contentType: 'application/xml; charset=utf-8',
		etag,
		lastModified: latest
	});
};
