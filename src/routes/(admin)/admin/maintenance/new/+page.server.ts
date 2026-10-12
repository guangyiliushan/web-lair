import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { recordActivity } from '$lib/server/audit';
import { resolveDataDir } from '$lib/server/jobs/data-dir';
import { saveScript } from '$lib/server/jobs/job-scripts';
import { enqueueJob } from '$lib/server/jobs/queue';
import { sanitizeErrorText } from '$lib/server/jobs/error-text';
import { resolveJobDefinition } from '$lib/server/jobs/user-layer';
import { parseBaseHash, parseCode } from '../maintenance-form-utils';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * /admin/maintenance/new (J-3): create a user-only job - the missing half of
 * "free create / delete / edit" (the editor page handles existing names; a fresh name has no
 * file, so saving here is exactly the `baseHash: null` creation path). The
 * save gate validates the name (alias/device/length rules); on success both
 * actions redirect - plain save lands on the [name] page, save-and-run lands
 * on the list so the fresh queued row is visible in the ledger (plan §4.4).
 */

const TEMPLATE = `import { getOption, type JobContext } from '#jobs-sdk';

export default {
	async run(ctx: JobContext): Promise<void> {
		ctx.logger.info('hello from a new job');
	}
};
`;

export const load: PageServerLoad = async () => {
	await requireAdminRole();
	return {
		headerTitle: `${m.admin_nav_maintenance()} · ${m.admin_maintenance_new_script()}`,
		template: TEMPLATE
	};
};

function requiredNameError(
	message: string
): { source: 'name'; line: null; column: null; message: string }[] {
	return [{ source: 'name', line: null, column: null, message }];
}

export const actions: Actions = {
	save: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const name = (form.get('name') ?? '').toString().trim();
		if (!name)
			return fail(400, { errors: requiredNameError(m.admin_maintenance_err_missing_name()) });
		const result = await saveScript({
			dataDir: resolveDataDir(),
			name,
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
				message: m.admin_maintenance_err_just_created()
			});
		}
		redirect(303, `/admin/maintenance/${encodeURIComponent(name)}`);
	},

	saveRun: async ({ request, locals }) => {
		await requireAdminRole();
		const dataDir = resolveDataDir();
		const form = await request.formData();
		const name = (form.get('name') ?? '').toString().trim();
		if (!name)
			return fail(400, { errors: requiredNameError(m.admin_maintenance_err_missing_name()) });
		const result = await saveScript({
			dataDir,
			name,
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
				message: m.admin_maintenance_err_just_created()
			});
		}
		// The save already landed: failures carry the fresh hash so the
		// editor can advance its optimistic-lock token (J-3 review P3-R2-2).
		const definition = await resolveJobDefinition(name, dataDir);
		if (!definition) {
			return fail(404, {
				message: m.admin_maintenance_err_parse({ name: name }),
				hash: result.hash
			});
		}
		if (!definition.manual) {
			return fail(400, { message: m.admin_maintenance_manual_blocked(), hash: result.hash });
		}
		let queued;
		try {
			queued = await enqueueJob(db, name, 'manual', definition);
		} catch (error) {
			console.error('[jobs] manual enqueue failed', error);
			return fail(400, { message: sanitizeErrorText(error), hash: result.hash });
		}
		await recordActivity(db, {
			event: 'job.run',
			actorId: locals.user?.id ?? null,
			payload: { name, trigger: 'manual', deduplicated: queued.deduplicated, via: 'save-and-run' }
		});
		redirect(303, '/admin/maintenance');
	}
};
