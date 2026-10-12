import { fail } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { thoughts } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { isUuid } from '$lib/utils/uuid';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * Admin thoughts CRUD (C3): content-only rows from `thoughts`. The load and
 * every action follow the P2 contract (requireAdminRole first, uuid entry
 * guard, explicit 400s; unknown ids 404 through the `returning` probe). The
 * list streams as a deferred promise for the ui-ux plan C1 Skeleton.
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();
	const [siteTz, countRows] = await Promise.all([
		getOption('site.timezone'),
		db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(thoughts)
	]);
	const total = countRows[0]?.count ?? 0;
	const rows = db
		.select({
			id: thoughts.id,
			content: thoughts.content,
			createdAt: thoughts.createdAt
		})
		.from(thoughts)
		.orderBy(desc(thoughts.createdAt))
		.then((items) =>
			items.map((item) => ({
				...item,
				dateLabel: formatDate(item.createdAt, { timeZone: siteTz })
			}))
		);
	return {
		headerTitle: m.admin_nav_thoughts(),
		total,
		rows
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const content = (form.get('content') ?? '').toString().trim();
		if (!content) return fail(400, { error: m.admin_thoughts_err_content() });
		await db.insert(thoughts).values({ content });
		return { success: true };
	},

	update: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_thoughts_err_missing_id() });
		const content = (form.get('content') ?? '').toString().trim();
		if (!content) return fail(400, { error: m.admin_thoughts_err_content() });
		const updated = await db
			.update(thoughts)
			.set({ content })
			.where(eq(thoughts.id, id))
			.returning({ id: thoughts.id });
		if (updated.length === 0) return fail(404, { error: m.admin_thoughts_err_not_found() });
		return { success: true };
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_thoughts_err_missing_id() });
		const deleted = await db
			.delete(thoughts)
			.where(eq(thoughts.id, id))
			.returning({ id: thoughts.id });
		if (deleted.length === 0) return fail(404, { error: m.admin_thoughts_err_not_found() });
		return { success: true };
	}
};
