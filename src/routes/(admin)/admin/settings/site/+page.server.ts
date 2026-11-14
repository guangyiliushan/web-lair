import type { PageServerLoad } from './$types';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';

/**
 * Foundation read view for Site (W3.5). W5 adds the site identity/languages/
 * timezone forms; this page only displays the current option values so no
 * control claims a consumer it does not have yet.
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();
	const [info, languages, defaultLang, timezone] = await Promise.all([
		getOption('site.info'),
		getOption('site.languages'),
		getOption('site.default_lang'),
		getOption('site.timezone')
	]);
	return { info, languages, defaultLang, timezone };
};
