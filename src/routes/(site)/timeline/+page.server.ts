import { and, desc, eq } from 'drizzle-orm';
import { getLocale } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { posts } from '$lib/server/db/content';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad } from './$types';

/**
 * Timeline (P3-b): one chronological stream over the content types.
 * `?type=post` / `?type=note` filter the stream; anything else (default,
 * `all`, the registered `memory`) shows everything currently wired. Notes
 * join the stream with N1 — until then `type=note` renders the empty state.
 */
export const load: PageServerLoad = async ({ url }) => {
	const lang = getLocale();
	const now = new Date();
	const requested = url.searchParams.get('type');
	const type = requested === 'post' || requested === 'note' ? requested : 'all';

	const rows =
		type === 'note'
			? []
			: await db
					.select({ slug: posts.slug, title: posts.title, publishedAt: posts.publishedAt })
					.from(posts)
					.where(and(eq(posts.lang, lang), visiblePostCondition(now)))
					.orderBy(desc(posts.publishedAt), desc(posts.id));

	return {
		type,
		items: rows.map((row) => ({
			kind: 'post' as const,
			slug: row.slug,
			title: row.title,
			date: row.publishedAt ? formatDate(row.publishedAt) : ''
		}))
	};
};
