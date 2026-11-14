import type { PageServerLoad } from './$types';

/**
 * Homepage data (W4.3/W4.5). The owner social rail already rides the site
 * chrome (`parent()`), so the homepage never re-queries the profile; the
 * hero copy read is added in W4.5.
 */
export const load: PageServerLoad = async ({ parent }) => {
	const { ownerLinks } = await parent();
	return { ownerLinks: ownerLinks ?? [] };
};
