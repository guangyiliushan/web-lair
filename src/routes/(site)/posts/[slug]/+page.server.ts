import { error } from '@sveltejs/kit';
import { and, eq, ne } from 'drizzle-orm';
import { getLocale, localizeHref, locales } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { categories, posts } from '$lib/server/db/content';
import { renderMarkdownToHtml } from '$lib/server/markdown';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad } from './$types';

/**
 * Public post detail (P3-a minimal read side): the post must exist in the
 * URL's locale and pass the shared visibility condition. A missing language
 * version is a 404 with a hint listing the languages that do have the same
 * slug — never an automatic fallback (ledger §9.16.5). The slug fallback
 * chain (slug_trackers) is P3-b.
 */
export const load: PageServerLoad = async ({ params }) => {
	const lang = getLocale();
	const { slug } = params;
	// One timestamp for both visibility checks, so a boundary post cannot be
	// hidden for this language yet listed as available in the hint query.
	const now = new Date();

	const [row] = await db
		.select({
			slug: posts.slug,
			title: posts.title,
			content: posts.content,
			publishedAt: posts.publishedAt,
			categoryName: categories.name
		})
		.from(posts)
		.innerJoin(categories, eq(posts.categoryId, categories.id))
		.where(and(eq(posts.lang, lang), eq(posts.slug, slug), visiblePostCondition(now)))
		.limit(1);

	if (!row) {
		const others = await db
			.selectDistinct({ lang: posts.lang })
			.from(posts)
			.where(and(eq(posts.slug, slug), ne(posts.lang, lang), visiblePostCondition(now)));

		const order = locales as readonly string[];
		if (others.length > 0) {
			const available = [...new Set(others.map((other) => other.lang))]
				.filter((tag) => order.includes(tag))
				.sort((a, b) => order.indexOf(a) - order.indexOf(b))
				.map((tag) => ({
					lang: tag,
					href: localizeHref(`/posts/${slug}`, { locale: tag as (typeof locales)[number] })
				}));
			error(404, {
				message: 'This post is not available in this language',
				available
			});
		}
		error(404, 'Not found');
	}

	const html = row.content ? await renderMarkdownToHtml(row.content) : '';

	return {
		post: {
			slug: row.slug,
			title: row.title,
			date: row.publishedAt ? formatDate(row.publishedAt) : '',
			category: row.categoryName
		},
		html
	};
};
