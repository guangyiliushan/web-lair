import { db } from '$lib/server/db';
import { tags } from '$lib/server/db/content';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// Tags are a real entity table since P1; the relation lives in post_tags.
	// (A per-tag article count was computed here until P1.1 - nothing consumed
	// it; when a count is actually shown, the §9.4 live-aggregate rule applies.)
	const rows = await db
		.select({ id: tags.id, name: tags.name, slug: tags.slug })
		.from(tags)
		.orderBy(tags.name);

	return { headerTitle: '标签', tags: rows };
};
