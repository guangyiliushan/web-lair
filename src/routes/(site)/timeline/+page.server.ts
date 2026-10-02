import { and, desc, eq } from 'drizzle-orm';
import { getLocale } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { posts } from '$lib/server/db/content';
import { listNoteSummaries } from '$lib/server/services/notes';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad } from './$types';

export interface TimelineItem {
	kind: 'post' | 'note';
	slug: string;
	title: string;
	date: string;
	/** Password-gated notes keep their lock marker in the stream (N1). */
	locked: boolean;
}

/**
 * Timeline (P3-b + N1): one chronological stream over the content types.
 * `?type=post` / `?type=note` filter the stream; anything else (default,
 * `all`, the registered `memory`) shows everything currently wired. Notes
 * join the stream with N1 - gated rows carry their lock marker.
 */
export const load: PageServerLoad = async ({ url }) => {
	const lang = getLocale();
	const now = new Date();
	const requested = url.searchParams.get('type');
	const type = requested === 'post' || requested === 'note' ? requested : 'all';

	const postRows =
		type === 'note'
			? []
			: await db
					.select({ slug: posts.slug, title: posts.title, publishedAt: posts.publishedAt })
					.from(posts)
					.where(and(eq(posts.lang, lang), visiblePostCondition(now)))
					.orderBy(desc(posts.publishedAt), desc(posts.id));
	const noteRows = type === 'post' ? [] : await listNoteSummaries(lang, { now });

	const items: Array<Omit<TimelineItem, 'date'> & { publishedAt: Date }> = [
		...postRows.flatMap((row) =>
			row.publishedAt
				? [
						{
							kind: 'post' as const,
							slug: row.slug,
							title: row.title,
							locked: false,
							publishedAt: row.publishedAt
						}
					]
				: []
		),
		...noteRows.map((row) => ({
			kind: 'note' as const,
			slug: row.slug,
			title: row.title,
			locked: row.locked,
			publishedAt: row.publishedAt
		}))
	].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

	return {
		type,
		items: items.map(({ publishedAt, ...item }) => ({ ...item, date: formatDate(publishedAt) }))
	};
};
