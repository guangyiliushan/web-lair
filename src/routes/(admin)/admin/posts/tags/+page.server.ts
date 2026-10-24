import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { tags } from '$lib/server/db/content';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { isValidTaxonomySlug } from '$lib/server/services/taxonomy';
import type { Actions } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * Creation lives on the list route; update/delete live on `[id]` because a
 * form can only post to the route that renders it.
 */
export const actions: Actions = {
	create: async ({ request }) => {
		await requireAdminRole();
		const formData = await request.formData();
		const name = formData.get('name')?.toString().trim();
		const slug = formData.get('slug')?.toString().trim().toLowerCase();

		if (!name) return fail(400, { error: m.admin_tags_err_name_required() });
		if (!slug) return fail(400, { error: m.admin_tags_err_slug_required() });
		if (!isValidTaxonomySlug(slug)) return fail(400, { error: m.admin_taxonomy_err_slug_shape() });

		let created: { id: string };
		try {
			[created] = await db.insert(tags).values({ name, slug }).returning({ id: tags.id });
		} catch (error) {
			if (pgErrorCode(error) !== '23505') throw error;
			return fail(409, { error: m.admin_tags_err_duplicate() });
		}
		// Land on the new record so the workspace opens immediately.
		redirect(303, `/admin/posts/tags/${created.id}`);
	}
};
