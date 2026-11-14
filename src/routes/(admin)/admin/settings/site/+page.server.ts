import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { ADMIN_BASE_PATH } from '$lib/server/config/admin';
import { getPublicOrigin } from '$lib/server/origin';
import { APP_VERSION } from '$lib/server/version';
import { settingAccess } from '$lib/server/settings/tiers';

/**
 * Foundation read view for Site (W3.5). W5 adds the site identity/languages/
 * timezone forms; this page only displays the current option values so no
 * control claims a consumer it does not have yet.
 */
export const load: PageServerLoad = async (event) => {
	await requireAdminRole();
	const [info, languages, defaultLang, timezone] = await Promise.all([
		getOption('site.info'),
		getOption('site.languages'),
		getOption('site.default_lang'),
		getOption('site.timezone')
	]);
	return {
		info,
		languages,
		defaultLang,
		timezone,
		editable: settingAccess(event.locals.admin?.role, 'site').editable,
		deployment: {
			origin: getPublicOrigin(),
			adminPath: ADMIN_BASE_PATH,
			environment: process.env.NODE_ENV ?? 'development',
			version: env.APP_VERSION?.trim() || APP_VERSION
		}
	};
};
