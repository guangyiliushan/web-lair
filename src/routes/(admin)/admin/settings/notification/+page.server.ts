import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Old IA route kept as a permanent redirect. */
export const load: PageServerLoad = () => {
	redirect(308, '/admin/settings/notifications');
};
