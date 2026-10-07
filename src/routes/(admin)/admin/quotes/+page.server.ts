import { fail } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { quotes } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { isUuid } from '$lib/utils/uuid';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad, Actions } from './$types';

/**
 * Admin 摘录 CRUD (C3): real rows from `quotes` (content required; author /
 * source optional). The load and every action follow the P2 contract -
 * requireAdminRole first, uuid entry guard, explicit 400s; unknown ids answer
 * 404 through the `returning` probe. The list itself streams as a deferred
 * promise so the page can show the ui-ux plan C1 Skeleton while it loads.
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();
	const [siteTz, countRows] = await Promise.all([
		getOption('site.timezone'),
		db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(quotes)
	]);
	const total = countRows[0]?.count ?? 0;
	const rows = db
		.select({
			id: quotes.id,
			content: quotes.content,
			author: quotes.author,
			source: quotes.source,
			createdAt: quotes.createdAt
		})
		.from(quotes)
		.orderBy(desc(quotes.createdAt))
		.then((items) =>
			items.map((item) => ({
				...item,
				dateLabel: formatDate(item.createdAt, { timeZone: siteTz })
			}))
		);
	return {
		headerTitle: '摘录',
		total,
		rows
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const content = (form.get('content') ?? '').toString().trim();
		if (!content) return fail(400, { error: '摘录内容不能为空' });
		const author = (form.get('author') ?? '').toString().trim() || null;
		const source = (form.get('source') ?? '').toString().trim() || null;
		await db.insert(quotes).values({ content, author, source });
		return { success: true };
	},

	update: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: '缺少摘录 ID' });
		const content = (form.get('content') ?? '').toString().trim();
		if (!content) return fail(400, { error: '摘录内容不能为空' });
		const author = (form.get('author') ?? '').toString().trim() || null;
		const source = (form.get('source') ?? '').toString().trim() || null;
		const updated = await db
			.update(quotes)
			.set({ content, author, source })
			.where(eq(quotes.id, id))
			.returning({ id: quotes.id });
		if (updated.length === 0) return fail(404, { error: '摘录不存在' });
		return { success: true };
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: '缺少摘录 ID' });
		const deleted = await db.delete(quotes).where(eq(quotes.id, id)).returning({ id: quotes.id });
		if (deleted.length === 0) return fail(404, { error: '摘录不存在' });
		return { success: true };
	}
};
