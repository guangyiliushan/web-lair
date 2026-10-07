import { ne, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { moments, notes, posts, quotes, thoughts } from '$lib/server/db/content';
import type { PageServerLoad } from './$types';

/**
 * Admin dashboard (C3): the five quick-action counters read real rows
 * (posts exclude trash). The stat cards below stay mock until their own
 * batches wire their sources.
 */
export const load: PageServerLoad = async () => {
	const [[postRow], [noteRow], [quoteRow], [thoughtRow], [momentRow]] = await Promise.all([
		db
			.select({ count: sql<number>`count(*)`.mapWith(Number) })
			.from(posts)
			.where(ne(posts.status, 'trash')),
		db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(notes),
		db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(quotes),
		db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(thoughts),
		db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(moments)
	]);
	return {
		headerTitle: '仪表盘',
		counts: {
			posts: postRow?.count ?? 0,
			notes: noteRow?.count ?? 0,
			quotes: quoteRow?.count ?? 0,
			thoughts: thoughtRow?.count ?? 0,
			moments: momentRow?.count ?? 0
		}
	};
};
