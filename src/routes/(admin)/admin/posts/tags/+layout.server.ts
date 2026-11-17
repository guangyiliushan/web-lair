import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { postTags, tags } from '$lib/server/db/content';
import { sql } from 'drizzle-orm';
import type { LayoutServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * The list is layout-level: both `/tags` and `/tags/[id]` render the list pane,
 * so they share one load. It reads no `url`/`params`, so selecting a row does
 * not refetch the list.
 *
 * Usage counts come from `post_tags` — tags are M:N with posts, unlike
 * categories which own their posts outright (a live aggregate, no counter column).
 */
export const load: LayoutServerLoad = async () => {
	await requireAdminRole();

	const allTags = await db
		.select({
			id: tags.id,
			name: tags.name,
			slug: tags.slug,
			description: tags.description
		})
		.from(tags)
		.orderBy(tags.name);

	const rows = await db
		.select({ tagId: postTags.tagId, count: sql<number>`count(*)`.mapWith(Number) })
		.from(postTags)
		.groupBy(postTags.tagId);

	const usageCounts: Record<string, number> = {};
	for (const r of rows) usageCounts[r.tagId] = r.count;

	return {
		headerTitle: m.admin_tags_nav(),
		tags: allTags,
		usageCounts
	};
};
