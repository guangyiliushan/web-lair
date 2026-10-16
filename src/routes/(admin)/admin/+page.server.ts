import { ne, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { moments, notes, posts, quotes, thoughts } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { readSitePresence } from '$lib/server/services/presence';
import { m } from '$lib/paraglide/messages';
import type { PageServerLoad } from './$types';

/**
 * Admin dashboard (C3): the load is admin-guarded and the five quick-action
 * counters read real rows (posts exclude trash). The realtime cards carry SSR
 * initial values from the presence service (site window / today's unique tabs
 * / daily peak sentinel) and the page upgrades them over the admin SSE
 * stream; when presence is disabled or the cache is unavailable the values
 * stay null and the cards render "—" (register E1/F3).
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();
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
	const presenceEnabled = await getOption('presence.enabled');
	const realtime = presenceEnabled ? await readSitePresence() : null;
	return {
		headerTitle: m.admin_nav_dashboard(),
		counts: {
			posts: postRow?.count ?? 0,
			notes: noteRow?.count ?? 0,
			quotes: quoteRow?.count ?? 0,
			thoughts: thoughtRow?.count ?? 0,
			moments: momentRow?.count ?? 0
		},
		presence: {
			enabled: presenceEnabled,
			site: realtime?.site ?? null,
			day: realtime?.day ?? null,
			peak: realtime?.peak ?? null
		}
	};
};
