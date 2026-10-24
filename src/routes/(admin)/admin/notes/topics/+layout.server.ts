import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { notes, topics } from '$lib/server/db/content';
import { sql } from 'drizzle-orm';
import type { LayoutServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * The list is layout-level: both `/topics` and `/topics/[id]` render the list
 * pane, so they share one load. It reads no `url`/`params`, so selecting a row
 * does not refetch the list.
 *
 * Unlike `posts.category_id`, `notes.topic_id` is SET NULL — a note may sit
 * outside every topic — so there is no fallback bucket to keep and no default
 * row to protect.
 */
export const load: LayoutServerLoad = async () => {
	await requireAdminRole();

	const [rows, counts] = await Promise.all([
		db
			.select({
				id: topics.id,
				name: topics.name,
				slug: topics.slug,
				description: topics.description,
				icon: topics.icon,
				sortOrder: topics.sortOrder,
				sourceLang: topics.sourceLang,
				nameI18n: topics.nameI18n,
				descriptionI18n: topics.descriptionI18n
			})
			.from(topics)
			.orderBy(topics.sortOrder, topics.name),
		db
			.select({
				topicId: notes.topicId,
				count: sql<number>`count(${notes.id})`.mapWith(Number)
			})
			.from(notes)
			.groupBy(notes.topicId)
	]);

	const noteCounts: Record<string, number> = {};
	for (const row of counts) {
		if (row.topicId) noteCounts[row.topicId] = row.count;
	}

	return {
		headerTitle: m.admin_notes_topics(),
		topics: rows,
		noteCounts
	};
};
