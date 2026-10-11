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
import { m } from '$lib/paraglide/messages';

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
	if (!id || !isUuid(id)) error(404, m.admin_pages_err_not_found());

	const [row] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
	if (!row) error(404, m.admin_pages_err_not_found());

	return {
		headerTitle: m.admin_pages_edit_title(),
		headerActions: [
			{
				label: m.admin_common_back(),
				iconName: 'arrow-left',
				variant: 'outline',
				href: '/admin/pages'
			}
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
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_pages_err_missing_id() });
		const pageId = id.toLowerCase();

		const [row] = await db
			.select({ id: pages.id, slug: pages.slug, isDefault: pages.isDefault })
			.from(pages)
			.where(eq(pages.id, pageId))
			.limit(1);
		if (!row) return fail(404, { error: m.admin_pages_err_not_found() });

		const title = localizedFrom(form, 'title');
		if (Object.keys(title).length === 0)
			return fail(400, { error: m.admin_pages_err_title_required() });

		const description = localizedFrom(form, 'description');
		const icon = str(form, 'icon').trim();
		if (icon !== '' && !(NAV_ICON_NAMES as readonly string[]).includes(icon)) {
			return fail(400, { error: m.admin_pages_err_icon_whitelist() });
		}
		const externalUrl = str(form, 'externalUrl').trim();
		if (externalUrl !== '' && !/^https?:\/\//.test(externalUrl)) {
			return fail(400, { error: m.admin_pages_err_bad_external() });
		}

		const slug = str(form, 'slug').trim().toLowerCase();
		if (!slug) return fail(400, { error: m.admin_pages_err_slug_required() });
		if (!SLUG_RE.test(slug)) return fail(400, { error: m.admin_pages_err_bad_slug() });
		if (slug !== row.slug) {
			if (row.isDefault) return fail(400, { error: m.admin_pages_err_slug_locked() });
			if (isReservedPageSlug(slug)) return fail(400, { error: m.admin_pages_err_slug_reserved() });
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
			return fail(409, { error: m.admin_pages_err_slug_taken() });
		}
		if (updated.length === 0) return fail(404, { error: m.admin_pages_err_not_found() });
		return { success: true };
	}
};
