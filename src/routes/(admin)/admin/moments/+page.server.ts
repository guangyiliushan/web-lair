import { fail } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { moments } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { isUuid } from '$lib/utils/uuid';
import { parseMomentKind } from '$lib/utils/moment-meta';
import { formatDate } from '$lib/utils/i18n';
import type { PageServerLoad, Actions } from './$types';

/**
 * Admin 微记 CRUD (C3): content + kind (`life|tech|media|other`, app-validated
 * with the DB CHECK as backstop) + read-only up/down counters. The load and
 * every action follow the P2 contract; the list streams for the ui-ux C1
 * Skeleton.
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();
	const [siteTz, countRows] = await Promise.all([
		getOption('site.timezone'),
		db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(moments)
	]);
	const total = countRows[0]?.count ?? 0;
	const rows = db
		.select({
			id: moments.id,
			content: moments.content,
			type: moments.type,
			up: moments.up,
			down: moments.down,
			createdAt: moments.createdAt
		})
		.from(moments)
		.orderBy(desc(moments.createdAt))
		.then((items) =>
			items.map((item) => ({
				...item,
				dateLabel: formatDate(item.createdAt, { timeZone: siteTz })
			}))
		);
	return {
		headerTitle: '微记',
		total,
		rows
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const content = (form.get('content') ?? '').toString().trim();
		if (!content) return fail(400, { error: '微记内容不能为空' });
		const kind = parseMomentKind((form.get('type') ?? '').toString());
		if (!kind) return fail(400, { error: '微记类型无效' });
		try {
			await db.insert(moments).values({ content, type: kind });
		} catch (caught) {
			// The `moments_type_check` CHECK is the backstop; the app-side
			// whitelist above should make this unreachable.
			if (pgErrorCode(caught) === '23514') return fail(400, { error: '微记类型无效' });
			throw caught;
		}
		return { success: true };
	},

	update: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: '缺少微记 ID' });
		const content = (form.get('content') ?? '').toString().trim();
		if (!content) return fail(400, { error: '微记内容不能为空' });
		const kind = parseMomentKind((form.get('type') ?? '').toString());
		if (!kind) return fail(400, { error: '微记类型无效' });
		try {
			const updated = await db
				.update(moments)
				.set({ content, type: kind })
				.where(eq(moments.id, id))
				.returning({ id: moments.id });
			if (updated.length === 0) return fail(404, { error: '微记不存在' });
		} catch (caught) {
			// The `moments_type_check` CHECK is the backstop; the app-side
			// whitelist above should make this unreachable.
			if (pgErrorCode(caught) === '23514') return fail(400, { error: '微记类型无效' });
			throw caught;
		}
		return { success: true };
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: '缺少微记 ID' });
		const deleted = await db
			.delete(moments)
			.where(eq(moments.id, id))
			.returning({ id: moments.id });
		if (deleted.length === 0) return fail(404, { error: '微记不存在' });
		return { success: true };
	}
};
