import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { categories } from '$lib/server/db/content';
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

		if (!name) return fail(400, { error: m.admin_categories_err_name_required() });
		if (!slug) return fail(400, { error: m.admin_categories_err_slug_required() });

		const [created] = await db
			.insert(categories)
			.values({ name, slug })
			.returning({ id: categories.id });

		// Land on the new record so the workspace opens immediately.
		redirect(303, `/admin/posts/categories/${created.id}`);
	}
};
