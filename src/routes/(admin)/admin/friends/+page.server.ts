import type { PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';

export const load: PageServerLoad = async () => {
	return {
		headerTitle: m.admin_nav_friends(),
		headerActions: [
			{
				label: m.admin_friends_add(),
				iconName: 'user-plus',
				variant: 'default',
				href: '/admin/friends/new'
			},
			{ label: m.admin_friends_visit(), iconName: 'external-link', href: '/' }
		]
	};
};
