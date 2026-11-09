import { fail, redirect } from '@sveltejs/kit';
import { requireAdminRole, requireOwnerRole, adminContextFor } from '$lib/server/authz';
import { isUuid } from '$lib/utils/uuid';
import { m } from '$lib/paraglide/messages';
import {
	acceptTranslation,
	deleteTranslation,
	discardTranslation,
	getTranslationPreview,
	listTranslations,
	purgeDiscardedTranslations,
	resyncTranslation,
	retryTranslation
} from '$lib/server/services/translations';
import { acceptMessage } from '$lib/server/services/translation-error-messages';
import type { PageServerLoad, Actions } from './$types';

const STATUSES = ['draft', 'accepted', 'discarded', 'all'] as const;
type Status = (typeof STATUSES)[number];

function parseStatus(raw: string | null): Status {
	return (STATUSES as readonly string[]).includes(raw ?? '') ? (raw as Status) : 'draft';
}

export const load: PageServerLoad = async ({ url, locals }) => {
	await requireAdminRole();
	const status = parseStatus(url.searchParams.get('status'));
	const lang = url.searchParams.get('lang') ?? '';
	const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
	// The preview rides a query param so the sheet is deep-linkable and needs no
	// client-side loader: one row's full bodies are read only when asked for.
	const requested = url.searchParams.get('preview') ?? '';
	const preview = isUuid(requested) ? await getTranslationPreview(requested) : null;
	const result = await listTranslations({ status, lang, page });
	return {
		headerTitle: m.admin_nav_translations(),
		status,
		lang,
		page: result.page,
		total: result.total,
		counts: result.counts,
		rows: result.rows,
		preview,
		// Bulk delete is the one action here that does not point at a row, so it
		// stays owner-only and the button is hidden rather than failing on click.
		canPurge: adminContextFor(locals.user)?.role === 'owner'
	};
};

export const actions: Actions = {
	accept: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!isUuid(id)) return fail(400, { message: m.admin_translations_err_bad_id() });
		const reviewer = locals.admin?.userId ?? locals.user?.id ?? null;
		const result = await acceptTranslation(id, reviewer);
		if (result.kind !== 'accepted') {
			return fail(result.kind === 'busy' ? 409 : 400, {
				message: acceptMessage(result.kind)
			});
		}
		// The workbench redirects to the target editor so the admin can review
		// and publish. Acceptance itself never publishes.
		throw redirect(
			303,
			result.targetType === 'note'
				? `/admin/notes/edit?id=${result.targetId}&translation=1`
				: `/admin/posts/edit?id=${result.targetId}&translation=1`
		);
	},

	discard: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!isUuid(id)) return fail(400, { message: m.admin_translations_err_bad_id() });
		const result = await discardTranslation(id);
		if (result.kind === 'discarded') return { message: m.admin_translations_flash_discarded() };
		return fail(404, { message: m.admin_translations_err_not_found() });
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!isUuid(id)) return fail(400, { message: m.admin_translations_err_bad_id() });
		const result = await deleteTranslation(id);
		if (result.kind === 'deleted') return { message: m.admin_translations_flash_deleted() };
		// The id rides along so the confirm dialog can tell which row the
		// failure belongs to (it shows the message in place of the page banner).
		if (result.kind === 'not-discarded') {
			return fail(409, { message: m.admin_translations_err_not_discarded(), id });
		}
		return fail(404, { message: m.admin_translations_err_not_found(), id });
	},

	/**
	 * Owner-only: this is the one action on the page that deletes rows the
	 * operator did not point at. Discarded candidates are history nobody reads,
	 * but a bulk delete still deserves the narrower role.
	 */
	purgeDiscarded: async () => {
		await requireOwnerRole();
		const removed = await purgeDiscardedTranslations();
		if (removed === 0) return { message: m.admin_translations_flash_purge_none() };
		return { message: m.admin_translations_flash_purged({ count: removed }) };
	},

	retry: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!isUuid(id)) return fail(400, { message: m.admin_translations_err_bad_id() });
		const result = await retryTranslation(id);
		if (result.kind === 'queued') return { message: m.admin_translations_flash_queued() };
		return fail(404, { message: m.admin_translations_err_not_found() });
	},

	resync: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!isUuid(id)) return fail(400, { message: m.admin_translations_err_bad_id() });
		const result = await resyncTranslation(id);
		if (result.kind === 'queued') return { message: m.admin_translations_flash_resync() };
		if (result.kind === 'target-published') {
			return fail(409, { message: m.admin_translations_err_resync_published() });
		}
		return fail(404, { message: m.admin_translations_err_not_found() });
	}
};
