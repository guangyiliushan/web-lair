import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { settingAccess } from '$lib/server/settings/tiers';

/**
 * Foundation read view for Storage (W3.5). W7 adds the provider control plane;
 * today the storage is the bundled RustFS container, so only the bucket name
 * and the real `media.purge` TTLs are shown. Secrets/endpoints never reach the
 * page.
 */
export const load: PageServerLoad = async (event) => {
	await requireAdminRole();
	const purge = await getOption('media.purge');
	return {
		purge,
		bucket: env.RUSTFS_BUCKET?.trim() || null,
		editable: settingAccess(event.locals.admin?.role, 'storage').editable
	};
};
