import type { LayoutServerLoad } from './$types';
import { requireAdminWorkspace } from '$lib/server/authz';

export const load: LayoutServerLoad = async (event) => {
	await requireAdminWorkspace();

	return {
		auth: {
			user: event.locals.user,
			profile: event.locals.profile
		}
	};
};
