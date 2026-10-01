import { and, count, desc, eq } from 'drizzle-orm';
import { getLocale } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { postTags, posts, tags } from '$lib/server/db/content';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import type { PageServerLoad } from './$types';

/**
 * Tags index (P3-b): tags that carry at least one visible post in the URL
 * locale, most used first. Empty tags are not linked (an index of reachable
 * content — the tag page stays reachable by its own URL).
 */
export const load: PageServerLoad = async () => {
	const lang = getLocale();
	const now = new Date();

	const rows = await db
		.select({ id: tags.id, name: tags.name, slug: tags.slug, total: count(posts.id) })
		.from(postTags)
		.innerJoin(tags, eq(postTags.tagId, tags.id))
		.innerJoin(
			posts,
			and(eq(posts.id, postTags.postId), eq(posts.lang, lang), visiblePostCondition(now))
		)
		.groupBy(tags.id)
		.orderBy(desc(count(posts.id)), tags.name);

	return {
		tags: rows.map((row) => ({ name: row.name, slug: row.slug, total: row.total }))
	};
};
