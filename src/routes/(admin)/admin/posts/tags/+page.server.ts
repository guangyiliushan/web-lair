import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { posts } from '$lib/server/db/content';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// Tags are stored as text arrays on posts — aggregate unique tags
	const rows = await db
		.select({
			name: sql<string>`unnest(${posts.tags})`.mapWith(String)
		})
		.from(posts)
		.groupBy(sql`unnest(${posts.tags})`)
		.orderBy(sql`unnest(${posts.tags})`);

	const allTags = [...new Set(rows.map((r) => r.name).filter(Boolean))].map((name, i) => ({
		id: `tag-${i}`,
		name,
		slug: name.toLowerCase().replace(/\s+/g, '-')
	}));

	return { headerTitle: '标签', tags: allTags };
};
