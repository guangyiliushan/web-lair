import { and, desc, eq } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import { getLocale } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { postTags, posts, tags } from '$lib/server/db/content';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad } from './$types';

/**
 * Tag detail (P3-b): visible posts carrying this tag in the URL locale,
 * newest first. The tag itself is language-neutral (§9.18.4), so only the
 * post filter is locale-scoped; an empty set renders the empty state.
 */
export const load: PageServerLoad = async ({ params }) => {
	const lang = getLocale();
	const now = new Date();

	const [tag] = await db
		.select({ id: tags.id, name: tags.name, slug: tags.slug })
		.from(tags)
		.where(eq(tags.slug, params.slug))
		.limit(1);
	if (!tag) throw error(404, 'Tag not found');

	const rows = await db
		.select({ slug: posts.slug, title: posts.title, publishedAt: posts.publishedAt })
		.from(postTags)
		.innerJoin(posts, eq(posts.id, postTags.postId))
		.where(and(eq(postTags.tagId, tag.id), eq(posts.lang, lang), visiblePostCondition(now)))
		.orderBy(desc(posts.publishedAt));

	return {
		tag: { name: tag.name, slug: tag.slug },
		posts: rows.map((row) => ({
			slug: row.slug,
			title: row.title,
			date: row.publishedAt ? formatDate(row.publishedAt) : ''
		}))
	};
};
