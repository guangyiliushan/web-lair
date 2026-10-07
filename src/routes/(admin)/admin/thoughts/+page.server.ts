import { fail } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { thoughts } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { isUuid } from '$lib/utils/uuid';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad, Actions } from './$types';

/**
 * Admin 思考 CRUD (C3): content-only rows from `thoughts`. Same P2 contract
 * as the sibling micro pages (requireAdminRole first, uuid entry guard,
 * explicit 400s; unknown ids 404 through the `returning` probe). The list
 * streams as a deferred promise for the ui-ux plan C1 Skeleton.
 */
export const load: PageServerLoad = async () => {
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
		headerTitle: '思考',
		total,
		rows
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const content = (form.get('content') ?? '').toString().trim();
		if (!content) return fail(400, { error: '思考内容不能为空' });
		await db.insert(thoughts).values({ content });
		return { success: true };
	},

	update: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: '缺少思考 ID' });
		const content = (form.get('content') ?? '').toString().trim();
		if (!content) return fail(400, { error: '思考内容不能为空' });
		const updated = await db
			.update(thoughts)
			.set({ content })
			.where(eq(thoughts.id, id))
			.returning({ id: thoughts.id });
		if (updated.length === 0) return fail(404, { error: '思考不存在' });
		return { success: true };
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: '缺少思考 ID' });
		const deleted = await db
			.delete(thoughts)
			.where(eq(thoughts.id, id))
			.returning({ id: thoughts.id });
		if (deleted.length === 0) return fail(404, { error: '思考不存在' });
		return { success: true };
	}
};
