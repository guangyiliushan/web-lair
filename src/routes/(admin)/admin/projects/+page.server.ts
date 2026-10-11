import { fail } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { formatDateTime } from '$lib/utils/i18n';
import { isUuid } from '$lib/utils/uuid';
import { isProjectProvider, isProjectStatus, type ProjectStatus } from '$lib/utils/project-meta';
import {
	ProjectsServiceError,
	createProject,
	deleteProjects,
	enqueueSync,
	getProject,
	getSyncTargets,
	importPrefill,
	latestSyncRun,
	listProjects,
	moveProject,
	projectCounts,
	setProjectStatus,
	setSyncTargets,
	updateProjectFields
} from '$lib/server/projects/service';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * Admin projects surface (plan §4, batch A): the real review queue replacing
 * the mockup. Load = tabs + counts + target list + the latest sync run +
 * streamed rows; actions cover the four-value state machine (single + bulk),
 * field edits (write-side URL scheme guard in the service), transactional
 * reordering, create, delete, the URL-import prefill and the target editor.
 * Same contract as the C3 admin pages: requireAdminRole first, uuid entry
 * guards, explicit 400s, unknown ids answer 404 through the service probe.
 */
export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();
	const statusParam = url.searchParams.get('status') ?? 'all';
	const filter: ProjectStatus | 'all' = isProjectStatus(statusParam) ? statusParam : 'all';
	const [siteTz, counts, targets, lastRun] = await Promise.all([
		getOption('site.timezone'),
		projectCounts(),
		getSyncTargets(),
		latestSyncRun()
	]);
	const rows = listProjects(filter).then((items) =>
		items.map((item) => ({
			...item,
			syncedLabel: item.lastSyncedAt
				? formatDateTime(item.lastSyncedAt, { timeZone: siteTz })
				: null
		}))
	);
	const focusId = url.searchParams.get('id');
	const focusRow = focusId && isUuid(focusId) ? await getProject(focusId) : null;
	return {
		headerTitle: m.admin_nav_projects(),
		filter,
		counts,
		targets,
		lastRun: lastRun
			? {
					...lastRun,
					createdLabel: formatDateTime(lastRun.createdAt, { timeZone: siteTz })
				}
			: null,
		focusRow,
		rows
	};
};

function text(form: FormData, name: string): string | null {
	const value = form.get(name);
	if (value === null) return null;
	const stringValue = value.toString();
	return stringValue.length === 0 ? null : stringValue;
}

const SERVICE_ERROR_TEXT: Record<string, () => string> = {
	'name-required': () => m.admin_projects_err_name_required(),
	'url-required': () => m.admin_projects_err_url_required(),
	'bad-url': () => m.admin_projects_err_bad_url(),
	'external-id-required': () => m.admin_projects_err_external_id_required(),
	'identity-mismatch': () => m.admin_projects_err_identity_mismatch(),
	duplicate: () => m.admin_projects_err_duplicate(),
	busy: () => m.admin_projects_err_busy(),
	missing: () => m.admin_projects_err_missing()
};

function serviceFail(err: unknown) {
	if (err instanceof ProjectsServiceError) {
		if (err.code === 'busy') return fail(409, { error: SERVICE_ERROR_TEXT.busy?.() });
		return fail(err.code === 'not_found' ? 404 : 400, {
			error: SERVICE_ERROR_TEXT[err.message]?.() ?? m.admin_projects_err_failed()
		});
	}
	throw err;
}

const IMPORT_ERROR_TEXT: Record<string, () => string> = {
	'invalid-url': () => m.admin_projects_import_err_invalid_url(),
	blocked: () => m.admin_projects_import_err_blocked(),
	not_found: () => m.admin_projects_import_err_not_found(),
	rate_limited: () => m.admin_projects_import_err_rate_limited(),
	auth: () => m.admin_projects_import_err_auth(),
	network: () => m.admin_projects_import_err_network(),
	parse: () => m.admin_projects_import_err_parse()
};

async function editFieldsFrom(form: FormData) {
	return {
		name: text(form, 'name') ?? '',
		description: text(form, 'description'),
		projectUrl: text(form, 'projectUrl') ?? '',
		previewUrl: text(form, 'previewUrl'),
		docUrl: text(form, 'docUrl'),
		avatar: text(form, 'avatar')
	};
}

function idsFrom(form: FormData): string[] {
	const ids = form
		.getAll('ids')
		.map((value) => value.toString())
		.filter(isUuid);
	return ids;
}

export const actions: Actions = {
	sync: async () => {
		await requireAdminRole();
		// Scenario #1 (§0.1): no targets configured -> steer the admin to the
		// target editor instead of queueing a guaranteed-empty run.
		const targets = await getSyncTargets();
		if (targets.length === 0) {
			return fail(400, { error: m.admin_projects_err_no_targets() });
		}
		const { deduplicated } = await enqueueSync();
		return { success: true, flash: deduplicated ? 'sync-dedup' : 'sync-queued' };
	},

	create: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const providerRaw = (form.get('provider') ?? 'site').toString();
		if (!isProjectProvider(providerRaw)) {
			return fail(400, { error: m.admin_projects_err_unknown_type() });
		}
		try {
			const { id } = await createProject({
				...(await editFieldsFrom(form)),
				provider: providerRaw,
				externalId: text(form, 'externalId'),
				fullName: text(form, 'fullName')
			});
			return { success: true, flash: 'created', createdId: id };
		} catch (err) {
			return serviceFail(err);
		}
	},

	update: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_projects_err_missing_id() });
		try {
			await updateProjectFields(id, await editFieldsFrom(form));
			return { success: true, flash: 'updated' };
		} catch (err) {
			return serviceFail(err);
		}
	},

	setStatus: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const ids = idsFrom(form);
		if (ids.length === 0) return fail(400, { error: m.admin_projects_err_no_selection() });
		const to = (form.get('to') ?? '').toString();
		if (!isProjectStatus(to)) return fail(400, { error: m.admin_projects_err_unknown_status() });
		const { updated, skipped } = await setProjectStatus(ids, to);
		return { success: true, flash: 'status-changed', updated, skipped };
	},

	reorder: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_projects_err_missing_id() });
		const move = (form.get('move') ?? '').toString();
		if (move !== 'up' && move !== 'down' && move !== 'top') {
			return fail(400, { error: m.admin_projects_err_unknown_action() });
		}
		try {
			await moveProject(id, move);
			return { success: true };
		} catch (err) {
			return serviceFail(err);
		}
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const single = (form.get('id') ?? '').toString();
		const ids = idsFrom(form);
		if (single && isUuid(single)) ids.push(single);
		if (ids.length === 0) return fail(400, { error: m.admin_projects_err_no_selection() });
		const deleted = await deleteProjects(ids);
		if (deleted === 0) return fail(404, { error: m.admin_projects_err_missing() });
		return { success: true, flash: 'deleted', deleted };
	},

	import: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const url = (form.get('url') ?? '').toString().trim();
		if (!url) return fail(400, { error: m.admin_projects_err_url_needed() });
		const result = await importPrefill(url);
		if (!result.ok) {
			return fail(400, {
				error: IMPORT_ERROR_TEXT[result.reason]?.() ?? m.admin_projects_import_err_failed()
			});
		}
		return { success: true, importResult: result.prefill };
	},

	targets: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const targets: { provider: string; account: string }[] = [];
		for (let index = 0; ; index += 1) {
			const provider = form.get(`provider_${index}`);
			if (provider === null) break;
			targets.push({
				provider: provider.toString(),
				account: (form.get(`account_${index}`) ?? '').toString()
			});
		}
		try {
			await setSyncTargets(targets as Awaited<ReturnType<typeof getSyncTargets>>);
			return { success: true, flash: 'targets-saved' };
		} catch (err) {
			// Only registry validation failures are user-fixable; anything else
			// (db down, ...) must surface honestly (review).
			if (err instanceof ZodError) {
				return fail(400, {
					error: m.admin_projects_err_targets_validation()
				});
			}
			throw err;
		}
	}
};
