import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { moments } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { isUuid } from '$lib/utils/uuid';
import { isMomentKind, MOMENT_KINDS } from '$lib/utils/moment-meta';
import { plainTextExcerpt } from '$lib/utils/excerpt';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

const PAGE_SIZE = 20;

/**
 * Admin moments CRUD: content + kind (`life|tech|media|other`, app-validated with
 * the DB CHECK as backstop) + read-only up/down counters.
 *
 * The list follows the same contract as the posts / notes admin lists - server side
 * keyword + kind filter + paging against the real `moments` table - so the three
 * share one table surface and one set of URL parameters.
 *
 * Writes live on `/admin/moments/edit`: the body is authored in the shared Markdown
 * editor, so the create/update actions moved there. This route keeps the list load
 * and the row delete action; `content` rows carry a markdown-stripped `excerpt` for
 * the table preview.
 */
export const load: PageServerLoad = async (event) => {
	// The guard runs first - before the event is even read - so an
	// unauthorised call can never reach the query layer (pinned by
	// moments-actions.test.ts).
	await requireAdminRole();
	const url = event.url;

	// Dashboard "Write" deep link (`/admin/moments?add=1`) used to open the
	// dialog; the editor is a route now, so forward the flag instead of
	// rendering a page that ignores it.
	if (url.searchParams.get('add') === '1') throw redirect(303, '/admin/moments/edit');

	const kindRaw = url.searchParams.get('type') ?? '';
	const keyword = (url.searchParams.get('keyword') ?? '').trim();
	// Number() accepts Infinity / 1e999 and the DB offset does not (mirrors the
	// posts / notes list guard).
	const rawPage = Number(url.searchParams.get('page') ?? '1');
	const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;

	const conditions = [];
	if (isMomentKind(kindRaw)) conditions.push(eq(moments.type, kindRaw));
	if (keyword) conditions.push(ilike(moments.content, `%${keyword}%`));
	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const [rows, totals] = await Promise.all([
		db
			.select({
				id: moments.id,
				content: moments.content,
				type: moments.type,
				up: moments.up,
				down: moments.down,
				createdAt: moments.createdAt
			})
			.from(moments)
			.where(where)
			.orderBy(desc(moments.createdAt))
			.limit(PAGE_SIZE)
			.offset((page - 1) * PAGE_SIZE),
		db
			.select({ count: sql<number>`count(*)`.mapWith(Number) })
			.from(moments)
			.where(where)
	]);

	return {
		headerTitle: m.admin_nav_moments(),
		// Plain link: the editor is a route now, not a dialog bound through the
		// action registry (`moments:create` retired with the dialog).
		headerActions: [
			{
				label: m.admin_common_new(),
				iconName: 'plus',
				variant: 'default',
				href: '/admin/moments/edit'
			}
		],
		moments: rows.map((row) => ({ ...row, excerpt: plainTextExcerpt(row.content, 140) })),
		totalCount: totals[0]?.count ?? 0,
		page,
		pageSize: PAGE_SIZE,
		filters: { type: kindRaw, keyword },
		kinds: MOMENT_KINDS
	};
};

export const actions: Actions = {
	/** Permanent delete (moments have no trash column). */
	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_moments_err_missing_id() });
		const deleted = await db
			.delete(moments)
			.where(eq(moments.id, id))
			.returning({ id: moments.id });
		if (deleted.length === 0) return fail(404, { error: m.admin_moments_err_not_found() });
		return { success: true };
	}
};
