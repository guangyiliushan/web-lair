import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { requireAdminRole } from '$lib/server/authz';
import { settingAccess } from '$lib/server/settings/tiers';

/**
 * Planned/read-only capability map for Integrations (W3.5, IA5/W10.1).
 * Only the GitHub rich cards have a real consumer (`GITHUB_TOKEN` in the
 * embed-meta endpoint); nothing on this page writes, so it renders statuses
 * only and never a token input or toggle.
 */
export const load: PageServerLoad = async (event) => {
	await requireAdminRole();
	return {
		githubConfigured: Boolean(env.GITHUB_TOKEN?.trim()),
		editable: settingAccess(event.locals.admin?.role, 'integrations').editable
	};
};
