import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Old IA route kept as a permanent redirect (M4 foundation, IA1/IA5). */
export const load: PageServerLoad = () => {
	redirect(308, '/admin/settings/profile');
};
