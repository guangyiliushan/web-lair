import { fail } from '@sveltejs/kit';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { notes, topics } from '$lib/server/db/content';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';

/**
 * Topics CRUD (notes plan §3.2): numeric sort_order plus ▲/▼ moves (no drag
 * dependencies, pages-line precedent) and a delete attribution check - the
 * FK is SET NULL, so the "still owns notes" refusal is application-level.
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();

	const [rows, counts] = await Promise.all([
		db
			.select({
				id: topics.id,
				name: topics.name,
				slug: topics.slug,
				description: topics.description,
				icon: topics.icon,
				sortOrder: topics.sortOrder
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

	return { headerTitle: '专栏', topics: rows, noteCounts };
};

function str(form: FormData, key: string): string {
	return (form.get(key) ?? '').toString();
}

export const actions: Actions = {
	create: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const name = str(form, 'name').trim();
		const slug = str(form, 'slug').trim().toLowerCase();
		const description = str(form, 'description').trim();
		const icon = str(form, 'icon').trim();
		const sortRaw = str(form, 'sortOrder').trim();

		if (!name) return fail(400, { error: '专栏名称不能为空' });
		if (!slug) return fail(400, { error: 'Slug 不能为空' });
		const sortOrder = /^-?\d+$/.test(sortRaw) ? Number(sortRaw) : 0;

		try {
			await db.insert(topics).values({
				name,
				slug,
				description,
				icon: icon === '' ? null : icon,
				sortOrder
			});
		} catch (error) {
			// Only a unique violation is a user-visible conflict; anything else
			// (connection lost, permissions) must surface as a server error.
			if (pgErrorCode(error) !== '23505') throw error;
			return fail(409, { error: '专栏名称或 Slug 已存在' });
		}
		return { success: true };
	},

	update: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id');
		const name = str(form, 'name').trim();
		const slug = str(form, 'slug').trim().toLowerCase();
		const description = str(form, 'description').trim();
		const icon = str(form, 'icon').trim();
		const sortRaw = str(form, 'sortOrder').trim();

		if (!id || !isUuid(id)) return fail(400, { error: '缺少专栏 ID' });
		if (!name) return fail(400, { error: '专栏名称不能为空' });
		if (!slug) return fail(400, { error: 'Slug 不能为空' });
		const sortOrder = /^-?\d+$/.test(sortRaw) ? Number(sortRaw) : 0;

		try {
			await db
				.update(topics)
				.set({ name, slug, description, icon: icon === '' ? null : icon, sortOrder })
				.where(eq(topics.id, id));
		} catch (error) {
			if (pgErrorCode(error) !== '23505') throw error;
			return fail(409, { error: '专栏名称或 Slug 已存在' });
		}
		return { success: true };
	},

	/** ▲/▼: deterministic full-list renumber inside one transaction. */
	move: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id');
		const direction = str(form, 'direction');
		if (!id || !isUuid(id)) return fail(400, { error: '缺少专栏 ID' });
		if (direction !== 'up' && direction !== 'down') return fail(400, { error: '方向无效' });

		const result = await db.transaction(async (tx) => {
			const ordered = await tx
				.select({ id: topics.id })
				.from(topics)
				.orderBy(asc(topics.sortOrder), asc(topics.name));
			const index = ordered.findIndex((row) => row.id === id);
			if (index < 0) return { kind: 'not-found' as const };
			const target = direction === 'up' ? index - 1 : index + 1;
			if (target < 0 || target >= ordered.length) return { kind: 'edge' as const };

			const swapped = [...ordered];
			[swapped[index], swapped[target]] = [swapped[target], swapped[index]];
			for (let position = 0; position < swapped.length; position += 1) {
				await tx
					.update(topics)
					.set({ sortOrder: position })
					.where(eq(topics.id, swapped[position].id));
			}
			return { kind: 'moved' as const };
		});

		if (result.kind === 'not-found') return fail(404, { error: '专栏不存在' });
		return { success: true };
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id');
		if (!id || !isUuid(id)) return fail(400, { error: '缺少专栏 ID' });

		// The notes FK is SET NULL, so the "still owns notes" refusal must be
		// explicit here (categories mirror the same intent with a RESTRICT FK).
		const [counts] = await db
			.select({ total: sql<number>`count(*)`.mapWith(Number) })
			.from(notes)
			.where(eq(notes.topicId, id));
		if ((counts?.total ?? 0) > 0) {
			return fail(409, {
				error: `该专栏下仍有 ${counts.total} 篇手记，无法删除（可先将手记改到其他专栏）`
			});
		}

		await db.delete(topics).where(eq(topics.id, id));
		return { success: true };
	}
};
