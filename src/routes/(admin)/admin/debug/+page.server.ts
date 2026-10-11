import type { PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';

export const load: PageServerLoad = async () => {
	return {
		headerTitle: m.admin_debug_title()
	};
};
