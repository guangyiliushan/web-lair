import { createHash } from 'node:crypto';
import { error, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { locales, localizeHref } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { posts } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { getPublicOrigin } from '$lib/server/origin';
import type { RequestHandler } from './$types';

function localeFromPath(pathname: string): (typeof locales)[number] | null {
	const first = pathname.split('/').filter(Boolean)[0];
	return (locales as readonly string[]).includes(first)
		? (first as (typeof locales)[number])
		: null;
}

function yaml(value: string): string {
	return JSON.stringify(value);
}

/**
 * Clean Markdown mirror: the same URL with `.md` instead of the page. Rendered on
 * demand, never added to the sitemap, and never bypassing the post visibility
 * predicate.
 */
export const GET: RequestHandler = async ({ url, params }) => {
	const lang = localeFromPath(url.pathname);
	if (!lang) {
		const defaultLang = await getOption('site.default_lang');
		redirect(302, `/${defaultLang}/posts/${params.slug}.md`);
	}
	const [row] = await db
		.select({
			title: posts.title,
			summary: posts.summary,
			content: posts.content,
			publishedAt: posts.publishedAt,
			updatedAt: posts.updatedAt
		})
		.from(posts)
		.where(and(eq(posts.lang, lang), eq(posts.slug, params.slug), visiblePostCondition(new Date())))
		.limit(1);
	if (!row) error(404, 'Not found');
	const origin = getPublicOrigin() ?? url.origin;
	const canonical = `${origin}${localizeHref(`/posts/${params.slug}`, { locale: lang })}`;
	const body = [
		'---',
		`title: ${yaml(row.title)}`,
		`lang: ${yaml(lang)}`,
		`canonical: ${yaml(canonical)}`,
		...(row.publishedAt ? [`published: ${yaml(row.publishedAt.toISOString())}`] : []),
		...(row.updatedAt ? [`updated: ${yaml(row.updatedAt.toISOString())}`] : []),
		'---',
		'',
		`# ${row.title}`,
		'',
		...(row.summary?.trim() ? [`> ${row.summary.trim()}`, ''] : []),
		row.content ?? ''
	].join('\n');
	const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'cache-control': 'public, max-age=300',
			etag,
			link: `<${canonical}>; rel="canonical", <${origin}${localizeHref('/llms.txt', { locale: lang })}>; rel="describedby"`
		}
	});
};
