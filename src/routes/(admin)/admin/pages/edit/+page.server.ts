import { error, fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { pages, type LocalizedText } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { NAV_ICON_NAMES } from '$lib/config/nav-icons';
import { isReservedPageSlug } from '$lib/utils/page-meta';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCALES = ['en', 'zh-cn', 'ja'] as const;

/**
 * Pages metadata editor (P2): title / description jsonb (three locales),
 * icon, external_url and slug. Body editing (and "新增") belongs to P5's md
 * editor; default rows keep a read-only slug (db:ensure-pages anchors on the
 * slug) and code rows show a route-sync warning for slug changes.
 */
export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();

	const id = url.searchParams.get('id');
	if (!id || !isUuid(id)) error(404, '页面不存在');

	const [row] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
	if (!row) error(404, '页面不存在');

	return {
		headerTitle: '编辑页面',
		headerActions: [
			{ label: '返回', iconName: 'arrow-left', variant: 'outline', href: '/admin/pages' }
		],
		page: {
			id: row.id,
			slug: row.slug,
			title: row.title,
			description: row.description ?? {},
			icon: row.icon ?? '',
			externalUrl: row.externalUrl ?? '',
			isDefault: row.isDefault,
			hasContent: row.content !== null,
			updatedAt: row.updatedAt
		}
	};
};

function str(form: FormData, key: string): string {
	return (form.get(key) ?? '').toString();
}

function localizedFrom(form: FormData, prefix: string): LocalizedText {
	const result: LocalizedText = {};
	for (const locale of LOCALES) {
		const value = str(form, `${prefix}_${locale}`).trim();
		if (value !== '') result[locale] = value;
	}
	return result;
}

export const actions: Actions = {
	save: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id');
		if (!id || !isUuid(id)) return fail(400, { error: '缺少页面 ID' });
		const pageId = id.toLowerCase();

		const [row] = await db
			.select({ id: pages.id, slug: pages.slug, isDefault: pages.isDefault })
			.from(pages)
			.where(eq(pages.id, pageId))
			.limit(1);
		if (!row) return fail(404, { error: '页面不存在' });

		const title = localizedFrom(form, 'title');
		if (Object.keys(title).length === 0) return fail(400, { error: '标题至少填写一种语言' });

		const description = localizedFrom(form, 'description');
		const icon = str(form, 'icon').trim();
		if (icon !== '' && !(NAV_ICON_NAMES as readonly string[]).includes(icon)) {
			return fail(400, { error: '图标不在白名单内（前台不会渲染）' });
		}
		const externalUrl = str(form, 'externalUrl').trim();
		if (externalUrl !== '' && !/^https?:\/\//.test(externalUrl)) {
			return fail(400, { error: '外链必须是 http(s) 地址（留空 = 站内页面）' });
		}

		const slug = str(form, 'slug').trim().toLowerCase();
		if (!slug) return fail(400, { error: 'Slug 不能为空' });
		if (!SLUG_RE.test(slug)) return fail(400, { error: 'Slug 仅允许小写英文、数字和连字符' });
		if (slug !== row.slug) {
			if (row.isDefault) return fail(400, { error: '默认页 Slug 不可修改（种子锚点）' });
			if (isReservedPageSlug(slug)) return fail(400, { error: '该 Slug 为保留词，请更换' });
		}

		let updated: { id: string }[];
		try {
			updated = await db
				.update(pages)
				.set({
					title,
					description: Object.keys(description).length > 0 ? description : null,
					icon: icon === '' ? null : icon,
					externalUrl: externalUrl === '' ? null : externalUrl,
					slug
				})
				.where(eq(pages.id, pageId))
				.returning({ id: pages.id });
		} catch (caught) {
			// Only a unique violation is a user-visible conflict (topics pattern).
			if (pgErrorCode(caught) !== '23505') throw caught;
			return fail(409, { error: 'Slug 已存在' });
		}
		if (updated.length === 0) return fail(404, { error: '页面不存在' });
		return { success: true };
	}
};
