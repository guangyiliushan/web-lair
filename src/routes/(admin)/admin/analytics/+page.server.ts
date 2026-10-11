import type { PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';

export const load: PageServerLoad = async () => {
	// TODO: Aggregate analytics overview from OpenPanel API
	return {
		headerTitle: m.admin_nav_analytics(),
		overview: {
			todayPv: 0,
			weekVisitors: 0,
			topPages: [] as { path: string; views: number }[],
			topOutgoingLinks: [] as { url: string; clicks: number }[]
		},
		dashboardUrl: ''
	};
};
