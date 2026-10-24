import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { topics } from '$lib/server/db/content';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { NAV_ICON_NAMES } from '$lib/config/nav-icons';
import {
	isValidTaxonomySlug,
	parseTaxonomyI18n,
	TAXONOMY_LOCALES
} from '$lib/server/services/taxonomy';
import type { Actions } from './$types';
import { m } from '$lib/paraglide/messages';

function str(form: FormData, key: string): string {
	return (form.get(key) ?? '').toString();
}

/**
 * Creation lives on the list route; update/move/delete/link live on `[id]`
 * because a form can only post to the route that renders it.
 */
export const actions: Actions = {
	create: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const name = str(form, 'name').trim();
		const slug = str(form, 'slug').trim().toLowerCase();
		const description = str(form, 'description').trim();
		const icon = str(form, 'icon').trim();
		const sortRaw = str(form, 'sortOrder').trim();
		const sourceRaw = str(form, 'sourceLang').trim();
		const sourceLang = (TAXONOMY_LOCALES as readonly string[]).includes(sourceRaw)
			? sourceRaw
			: 'zh-cn';

		if (!name) return fail(400, { error: m.admin_notes_topics_err_name_required() });
		if (!slug) return fail(400, { error: m.admin_notes_topics_err_slug_required() });
		if (!isValidTaxonomySlug(slug)) return fail(400, { error: m.admin_taxonomy_err_slug_shape() });
		if (icon !== '' && !(NAV_ICON_NAMES as readonly string[]).includes(icon)) {
			return fail(400, { error: m.admin_notes_topics_err_icon_whitelist() });
		}
		const sortOrder = /^-?\d+$/.test(sortRaw) ? Number(sortRaw) : 0;

		let created: { id: string };
		try {
			[created] = await db
				.insert(topics)
				.values({
					name,
					slug,
					description,
					icon: icon === '' ? null : icon,
					sortOrder,
					sourceLang,
					nameI18n: parseTaxonomyI18n(form, 'name', sourceLang),
					descriptionI18n: parseTaxonomyI18n(form, 'description', sourceLang)
				})
				.returning({ id: topics.id });
		} catch (error) {
			// Only a unique violation is a user-visible conflict; anything else
			// (connection lost, permissions) must surface as a server error.
			if (pgErrorCode(error) !== '23505') throw error;
			return fail(409, { error: m.admin_notes_topics_err_duplicate() });
		}
		// Land on the new record so the workspace opens immediately.
		redirect(303, `/admin/notes/topics/${created.id}`);
	}
};
