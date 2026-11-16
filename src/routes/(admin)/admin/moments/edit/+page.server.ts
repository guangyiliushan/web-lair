import { eq } from 'drizzle-orm';
import { error, fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { moments } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { isUuid } from '$lib/utils/uuid';
import { MOMENT_KINDS, parseMomentKind } from '$lib/utils/moment-meta';
import { m } from '$lib/paraglide/messages';
import type { PageServerLoad, Actions } from './$types';

const LIST_PATH = '/admin/moments';

/**
 * Admin moment editor: the write surface lives in its own route so the body uses
 * the same Markdown editor as posts / notes.
 *
 * There is no `drafts` row for moments - `drafts.ref_type` only whitelists
 * post/page/note (draft.schema.ts) - so this page saves directly instead of staging
 * a draft. The client keeps an unsaved-changes guard instead; the `save` action
 * either inserts (no `id`) or updates (`id`, 404 via `returning`) and always
 * redirects back to the list with a one-shot flash.
 */
export const load: PageServerLoad = async (event) => {
	// Guard first: an unauthorised call must never reach the query layer.
	await requireAdminRole();

	const id = (event.url.searchParams.get('id') ?? '').trim();
	const headerActions = [
		{
			label: m.admin_common_back(),
			iconName: 'arrow-left',
			variant: 'outline',
			href: LIST_PATH
		}
	];

	if (!id) {
		return {
			headerTitle: m.admin_moments_new(),
			headerActions,
			moment: null,
			kinds: MOMENT_KINDS
		};
	}

	// A malformed id answers 404 (never 22P02 through the uuid column).
	if (!isUuid(id)) throw error(404, m.admin_moments_err_not_found());

	const [row] = await db
		.select({
			id: moments.id,
			content: moments.content,
			type: moments.type,
			up: moments.up,
			down: moments.down,
			createdAt: moments.createdAt
		})
		.from(moments)
		.where(eq(moments.id, id))
		.limit(1);

	if (!row) throw error(404, m.admin_moments_err_not_found());

	return {
		headerTitle: m.admin_moments_edit(),
		headerActions,
		moment: row,
		kinds: MOMENT_KINDS
	};
};

export const actions: Actions = {
	/** One action for both branches: `id` absent = create, present = update. */
	save: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();

		const id = (form.get('id') ?? '').toString().trim();
		if (id && !isUuid(id)) return fail(400, { error: m.admin_moments_err_missing_id() });

		// Form encoding normalizes newlines to CRLF (HTML entry-list spec); the
		// markdown import boundary expects LF, and CRLF breaks line-anchored
		// transformers on re-open (posts/notes lesson). Normalise
		// here so the stored body is LF-only.
		const content = (form.get('content') ?? '').toString().replace(/\r\n?/g, '\n').trim();
		if (!content) return fail(400, { error: m.admin_moments_err_content() });

		const kind = parseMomentKind((form.get('type') ?? '').toString());
		if (!kind) return fail(400, { error: m.admin_moments_err_kind() });

		try {
			if (id) {
				const updated = await db
					.update(moments)
					.set({ content, type: kind })
					.where(eq(moments.id, id))
					.returning({ id: moments.id });
				if (updated.length === 0) return fail(404, { error: m.admin_moments_err_not_found() });
			} else {
				await db.insert(moments).values({ content, type: kind });
			}
		} catch (caught) {
			// The `moments_type_check` CHECK is the backstop; the app-side
			// whitelist above should make this unreachable.
			if (pgErrorCode(caught) === '23514') return fail(400, { error: m.admin_moments_err_kind() });
			throw caught;
		}

		throw redirect(303, `${LIST_PATH}?saved=1`);
	}
};
