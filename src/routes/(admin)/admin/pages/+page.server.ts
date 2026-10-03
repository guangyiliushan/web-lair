import { fail } from '@sveltejs/kit';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { getLocale } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { pages } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { resolveLocalized } from '$lib/server/services/pages';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';

/**
 * Pages admin v1 (P2, plan §4): the registry list with ▲/▼ reordering,
 * visible/hidden toggling and confirmed deletion. "新增" stays with P5 (the
 * md editor); `is_default` rows are protected here (no delete) and keep a
 * read-only slug in the editor (db:ensure-pages anchors on the slug).
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();

	const locale = getLocale();
	const rows = await db
		.select({
			id: pages.id,
			slug: pages.slug,
			title: pages.title,
			externalUrl: pages.externalUrl,
			status: pages.status,
			sortOrder: pages.sortOrder,
			isDefault: pages.isDefault,
			hasContent: sql<boolean>`${pages.content} is not null`.mapWith(Boolean),
			updatedAt: pages.updatedAt
		})
		.from(pages)
		.orderBy(desc(pages.isDefault), asc(pages.sortOrder), asc(pages.createdAt));

	return {
		headerTitle: '页面',
		pages: rows.map((row) => ({
			...row,
			title: resolveLocalized(row.title, locale) ?? row.slug
		}))
	};
};

function str(form: FormData, key: string): string {
	return (form.get(key) ?? '').toString();
}

export const actions: Actions = {
	/**
	 * ▲/▼: full-list renumber inside one transaction. The locking read
	 * serializes concurrent moves (P2 review); cross-group targets - the
	 * first extra's ▲ / the last default's ▼ - are a no-op success, since
	 * display order pins defaults first and writing there would only invert
	 * invisible sort values.
	 */
	move: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id');
		const direction = str(form, 'direction');
		if (!id || !isUuid(id)) return fail(400, { error: '缺少页面 ID' });
		if (direction !== 'up' && direction !== 'down') return fail(400, { error: '方向无效' });
		const pageId = id.toLowerCase();

		const result = await db.transaction(async (tx) => {
			const ordered = await tx
				.select({ id: pages.id, isDefault: pages.isDefault })
				.from(pages)
				.orderBy(desc(pages.isDefault), asc(pages.sortOrder), asc(pages.createdAt))
				.for('update');
			const index = ordered.findIndex((row) => row.id === pageId);
			if (index < 0) return { kind: 'not-found' as const };
			const target = direction === 'up' ? index - 1 : index + 1;
			if (
				target >= 0 &&
				target < ordered.length &&
				ordered[target].isDefault === ordered[index].isDefault
			) {
				const swapped = [...ordered];
				[swapped[index], swapped[target]] = [swapped[target], swapped[index]];
				for (let position = 0; position < swapped.length; position += 1) {
					// Raw SQL on purpose: the builder would merge the column's
					// `$onUpdate` into SET and bump every row's updated_at,
					// rotating the pages' sitemap lastmod on a pure reorder
					// (sorting is not a content change; P2 review).
					await tx.execute(
						sql`update pages set sort_order = ${position} where id = ${swapped[position].id}`
					);
				}
			}
			return { kind: 'moved' as const };
		});

		if (result.kind === 'not-found') return fail(404, { error: '页面不存在' });
		return { success: true };
	},

	setStatus: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id');
		const status = str(form, 'status');
		if (!id || !isUuid(id)) return fail(400, { error: '缺少页面 ID' });
		if (status !== 'visible' && status !== 'hidden') return fail(400, { error: '状态无效' });
		const pageId = id.toLowerCase();

		const updated = await db
			.update(pages)
			.set({ status })
			.where(eq(pages.id, pageId))
			.returning({ id: pages.id });
		if (updated.length === 0) return fail(404, { error: '页面不存在' });
		return { success: true };
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id');
		if (!id || !isUuid(id)) return fail(400, { error: '缺少页面 ID' });
		const pageId = id.toLowerCase();

		// Lock + guard + delete share one transaction (topics round-7 pattern).
		const result = await db.transaction(async (tx) => {
			const [row] = await tx
				.select({ id: pages.id, isDefault: pages.isDefault })
				.from(pages)
				.where(eq(pages.id, pageId))
				.limit(1)
				.for('update');
			if (!row) return { kind: 'not-found' as const };
			if (row.isDefault) return { kind: 'protected' as const };
			await tx.delete(pages).where(eq(pages.id, pageId));
			return { kind: 'deleted' as const };
		});

		if (result.kind === 'not-found') return fail(404, { error: '页面不存在' });
		if (result.kind === 'protected') return fail(409, { error: '默认页不可删除（可改为隐藏）' });
		return { success: true };
	}
};
