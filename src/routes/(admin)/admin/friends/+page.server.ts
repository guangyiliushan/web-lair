import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';
import { requireAdminRole, requireUser } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import {
	LinkAdminError,
	approveLink,
	banLink,
	checkOneLink,
	computeRowBadges,
	createLink,
	listLinks,
	linkCounts,
	purgeOutdated,
	queueCheckAll,
	rejectLink,
	removeLink,
	restoreLink,
	updateLink,
	type LinkAdminErrorCode
} from '$lib/server/links/admin';
import { isUuid } from '$lib/utils/uuid';
import type { LinkStatus } from '$lib/utils/link-meta';

/**
 * Friends console load (links L3): the real queue behind the mock shell.
 * `?state=` is a whitelist (unknown values fall back, never 400 - a stale
 * bookmark must not break the page); counts come from one aggregate query,
 * rows stream as a promise (projects precedent) so the header paints first.
 *
 * Default tab is `approved` until L4 ships: `pending` rows can only be
 * produced by the public application flow, so defaulting to pending would
 * greet the first visit with an empty table (2026-10-26 ruling, G2).
 */
const DEFAULT_STATE: LinkStatus = 'approved';
const STATES = new Set<LinkStatus>(['pending', 'approved', 'outdated', 'rejected', 'banned']);

function parseState(value: string | null): LinkStatus {
	return value !== null && STATES.has(value as LinkStatus) ? (value as LinkStatus) : DEFAULT_STATE;
}

export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();
	const state = parseState(url.searchParams.get('state'));
	const [checks, timeZone] = await Promise.all([
		getOption('friends.checks'),
		getOption('site.timezone')
	]);
	const counts = await linkCounts(checks.graceDays);
	const now = new Date();
	const rows = listLinks(state).then((items) =>
		items.map((item) => ({
			...item,
			badges: computeRowBadges(item, now, checks.graceDays)
		}))
	);

	return {
		headerTitle: m.admin_nav_friends(),
		headerActions: [
			{
				label: m.admin_friends_check_all(),
				iconName: 'search',
				variant: 'outline',
				// submits the hidden batch form registered by +page.svelte
				actionId: 'friends:check'
			},
			{
				label: m.admin_common_new(),
				iconName: 'plus',
				variant: 'default',
				// opens the add dialog registered by +page.svelte
				actionId: 'friends:create'
			}
		],
		state,
		counts,
		rows,
		timeZone,
		graceDays: checks.graceDays
	};
};

/** Service error codes → Paraglide keys (never leak raw codes to the page). */
const ERROR_TEXT: Record<LinkAdminErrorCode, () => string> = {
	missing: m.admin_friends_err_missing_id,
	stale: m.admin_friends_err_stale,
	'bad-status': m.admin_friends_err_bad_status,
	'name-required': m.admin_friends_err_name_required,
	'reason-required': m.admin_friends_err_reason_required,
	'note-required': m.admin_friends_err_note_required,
	'bad-url': m.admin_friends_err_bad_url,
	subpath: m.admin_friends_err_subpath,
	'backlink-required': m.admin_friends_err_backlink_required,
	'url-taken': m.admin_friends_err_url_taken,
	'name-taken': m.admin_friends_err_name_taken,
	'not-checkable': m.admin_friends_err_not_checkable,
	busy: m.admin_friends_err_busy,
	'checks-disabled': m.admin_friends_err_checks_disabled
};

function actionFail(err: unknown) {
	if (!(err instanceof LinkAdminError)) throw err;
	const status =
		err.code === 'missing'
			? 404
			: err.code === 'stale' || err.code === 'busy' || err.code === 'checks-disabled'
				? 409
				: 400;
	return fail(status, { error: ERROR_TEXT[err.code](), code: err.code });
}

function textFrom(form: FormData, name: string): string | null {
	const value = form.get(name);
	if (value === null) return null;
	const text = value.toString().trim();
	return text.length > 0 ? text : null;
}

function idFrom(form: FormData): string | null {
	const id = (form.get('id') ?? '').toString();
	return isUuid(id) ? id : null;
}

function numberFrom(form: FormData, name: string): number | null {
	const raw = form.get(name);
	if (raw === null || raw.toString().trim() === '') return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

function missingId() {
	return fail(400, { error: m.admin_friends_err_missing_id(), code: 'missing' });
}

function createInputFrom(form: FormData) {
	return {
		name: (form.get('name') ?? '').toString(),
		url: (form.get('url') ?? '').toString(),
		backlinkUrl: (form.get('backlinkUrl') ?? '').toString(),
		avatar: textFrom(form, 'avatar'),
		description: textFrom(form, 'description'),
		email: textFrom(form, 'email'),
		sortOrder: numberFrom(form, 'sortOrder') ?? undefined,
		checkEnabled: form.get('checkEnabled') !== null
	};
}

function updateInputFrom(form: FormData) {
	return {
		name: (form.get('name') ?? '').toString(),
		url: (form.get('url') ?? '').toString(),
		avatar: (form.get('avatar') ?? '').toString(),
		description: (form.get('description') ?? '').toString(),
		email: (form.get('email') ?? '').toString(),
		backlinkUrl: (form.get('backlinkUrl') ?? '').toString(),
		sortOrder: numberFrom(form, 'sortOrder') ?? 0,
		checkEnabled: form.get('checkEnabled') !== null
	};
}

export const actions: Actions = {
	create: async ({ request }) => {
		await requireAdminRole();
		try {
			await createLink(createInputFrom(await request.formData()), requireUser().id);
			return { success: true, flash: 'created' };
		} catch (err) {
			return actionFail(err);
		}
	},

	update: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = idFrom(form);
		if (!id) return missingId();
		try {
			await updateLink(id, updateInputFrom(form));
			return { success: true, flash: 'updated' };
		} catch (err) {
			return actionFail(err);
		}
	},

	approve: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = idFrom(form);
		if (!id) return missingId();
		try {
			await approveLink(id, { note: textFrom(form, 'note') }, requireUser().id);
			return { success: true, flash: 'approved' };
		} catch (err) {
			return actionFail(err);
		}
	},

	reject: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = idFrom(form);
		if (!id) return missingId();
		try {
			await rejectLink(id, { reason: textFrom(form, 'reason') }, requireUser().id);
			return { success: true, flash: 'rejected' };
		} catch (err) {
			return actionFail(err);
		}
	},

	ban: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = idFrom(form);
		if (!id) return missingId();
		try {
			await banLink(id, { reason: textFrom(form, 'reason') }, requireUser().id);
			return { success: true, flash: 'banned' };
		} catch (err) {
			return actionFail(err);
		}
	},

	restore: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = idFrom(form);
		if (!id) return missingId();
		try {
			await restoreLink(id, { note: textFrom(form, 'note') }, requireUser().id);
			return { success: true, flash: 'restored' };
		} catch (err) {
			return actionFail(err);
		}
	},

	remove: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = idFrom(form);
		if (!id) return missingId();
		try {
			await removeLink(id);
			return { success: true, flash: 'removed' };
		} catch (err) {
			return actionFail(err);
		}
	},

	purgeOutdated: async () => {
		await requireAdminRole();
		try {
			const { deleted } = await purgeOutdated();
			return { success: true, flash: 'purged', deleted };
		} catch (err) {
			return actionFail(err);
		}
	},

	checkOne: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = idFrom(form);
		if (!id) return missingId();
		try {
			await checkOneLink(id);
			return { success: true, flash: 'checked' };
		} catch (err) {
			return actionFail(err);
		}
	},

	checkAll: async () => {
		await requireAdminRole();
		try {
			const { deduplicated } = await queueCheckAll();
			return { success: true, flash: deduplicated ? 'check-dedup' : 'check-queued' };
		} catch (err) {
			return actionFail(err);
		}
	}
};
