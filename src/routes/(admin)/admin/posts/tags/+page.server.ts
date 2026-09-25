import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { postTags, tags } from '$lib/server/db/content';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// Tags are a real entity table since P1; the relation lives in post_tags.
	const rows = await db
		.select({
			id: tags.id,
			name: tags.name,
			slug: tags.slug,
			count: sql<number>`count(${postTags.postId})`.mapWith(Number)
		})
		.from(tags)
		.leftJoin(postTags, eq(postTags.tagId, tags.id))
		.groupBy(tags.id, tags.name, tags.slug)
		.orderBy(tags.name);

	return { headerTitle: '标签', tags: rows };
};
