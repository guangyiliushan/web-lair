import { error, fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { recordActivity } from '$lib/server/audit';
import { resolveDataDir } from '$lib/server/jobs/data-dir';
import {
	deleteUserJob,
	getScript,
	ignoreBuiltinUpdate,
	revertToBuiltin,
	saveScript
} from '$lib/server/jobs/job-scripts';
import { enqueueJob } from '$lib/server/jobs/queue';
import { sanitizeErrorText } from '$lib/server/jobs/error-text';
import { resolveJobDefinition } from '$lib/server/jobs/user-layer';
import { parseBaseHash, parseCode } from '../maintenance-form-utils';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * /admin/maintenance/[name] (J-3, plan §5.6): the script editor page -
 * CodeMirror mounts client-side behind a route-level dynamic import, saves
 * ride the J-2 optimistic lock (`baseHash` = the hash the editor loaded,
 * `bundle.user?.hash ?? null` - see the saveScript JSDoc), and the fork
 * lifecycle (首次保存即创建副本 / 恢复内置 / 忽略更新 / 硬删) hangs off the
 * same page. The editor NEVER auto-adopts a server value after an action:
 * conflict/reload is an explicit choice ("载入服务端最新"), mirroring the
 * drafts 409 precedent.
 */

export const load: PageServerLoad = async ({ params }) => {
	await requireAdminRole();
	const name = params.name;
	const bundle = await getScript(resolveDataDir(), name);
	if (!bundle) throw error(404, m.admin_maintenance_err_not_found({ name: name }));
	const { info, user, builtin } = bundle;
	return {
		headerTitle: `${m.admin_nav_maintenance()} · ${name}`,
		name,
		info,
		/** Editor seed + the optimistic-lock token for the next save. */
		saveCode: user?.code ?? builtin?.code ?? '',
		saveBaseHash: user?.hash ?? null,
		userCode: user?.code ?? null,
		builtinCode: builtin?.code ?? null
	};
};

export const actions: Actions = {
	save: async ({ request, params, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const result = await saveScript({
			dataDir: resolveDataDir(),
			name: params.name,
			code: parseCode(form),
			baseHash: parseBaseHash(form.get('baseHash')),
			actorId: locals.user?.id ?? null,
			db
		});
		if (result.kind === 'invalid') return fail(400, { errors: result.errors });
		if (result.kind === 'conflict') {
			return fail(409, {
				conflict: true,
				currentHash: result.currentHash,
				message: m.admin_maintenance_conflict()
			});
		}
		return { saved: true, hash: result.hash, created: result.created, forked: result.forked };
	},

	/** 保存并试运行 (plan §4.4): save, then queue one manual run. */
	saveRun: async ({ request, params, locals }) => {
		await requireAdminRole();
		const dataDir = resolveDataDir();
		const form = await request.formData();
		const result = await saveScript({
			dataDir,
			name: params.name,
			code: parseCode(form),
			baseHash: parseBaseHash(form.get('baseHash')),
			actorId: locals.user?.id ?? null,
			db
		});
		if (result.kind === 'invalid') return fail(400, { errors: result.errors });
		if (result.kind === 'conflict') {
			return fail(409, {
				conflict: true,
				currentHash: result.currentHash,
				message: m.admin_maintenance_conflict()
			});
		}
		// Re-resolve AFTER the save: a first save of a builtin name just
		// created the fork, and non-registry names need the user-layer
		// definition for enqueueJob (J-2 review D2 note).
		// The manifest already landed: every failure below carries the fresh
		// hash so the editor can advance its optimistic-lock token instead of
		// re-saving against a stale one (J-3 review P3-R2-2).
		const definition = await resolveJobDefinition(params.name, dataDir);
		if (!definition) {
			return fail(404, {
				message: m.admin_maintenance_err_parse({ name: params.name }),
				hash: result.hash
			});
		}
		if (!definition.manual) {
			return fail(400, { message: m.admin_maintenance_manual_blocked(), hash: result.hash });
		}
		let queued;
		try {
			queued = await enqueueJob(db, params.name, 'manual', definition);
		} catch (error) {
			console.error('[jobs] manual enqueue failed', error);
			return fail(400, { message: sanitizeErrorText(error), hash: result.hash });
		}
		await recordActivity(db, {
			event: 'job.run',
			actorId: locals.user?.id ?? null,
			payload: {
				name: params.name,
				trigger: 'manual',
				deduplicated: queued.deduplicated,
				via: 'save-and-run'
			}
		});
		// 跳台账 (plan §4.4): the fresh queued row in the ledger is the feedback.
		redirect(303, '/admin/maintenance');
	},

	revert: async ({ params, locals }) => {
		await requireAdminRole();
		const result = await revertToBuiltin({
			dataDir: resolveDataDir(),
			name: params.name,
			actorId: locals.user?.id ?? null,
			db
		});
		if (result.kind === 'not-forked') {
			return fail(400, { message: m.admin_maintenance_err_not_forked() });
		}
		return { reverted: true };
	},

	delete: async ({ params, locals }) => {
		await requireAdminRole();
		const result = await deleteUserJob({
			dataDir: resolveDataDir(),
			name: params.name,
			actorId: locals.user?.id ?? null,
			db
		});
		if (result.kind === 'not-user-job') {
			return fail(400, { message: m.admin_maintenance_err_not_deletable() });
		}
		redirect(303, '/admin/maintenance');
	},

	ignoreUpdate: async ({ params }) => {
		await requireAdminRole();
		const result = await ignoreBuiltinUpdate({ dataDir: resolveDataDir(), name: params.name });
		if (result.kind === 'not-forked')
			return fail(400, { message: m.admin_maintenance_err_no_copy() });
		if (result.kind === 'no-update')
			return fail(400, { message: m.admin_maintenance_err_no_update() });
		return { ignored: true, dismissed: result.dismissed };
	}
};
