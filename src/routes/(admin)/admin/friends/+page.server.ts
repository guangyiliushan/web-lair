import type { PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';

export const load: PageServerLoad = async () => {
	return {
		headerTitle: m.admin_nav_friends(),
		headerActions: [
			{
				label: m.admin_friends_check(),
				iconName: 'search',
				variant: 'outline',
				actionId: 'friends:check'
			},
			{
				label: m.admin_friends_migrate_avatars(),
				iconName: 'refresh',
				variant: 'outline',
				actionId: 'friends:migrate-avatars'
			},
			{
				label: m.admin_common_new(),
				iconName: 'plus',
				variant: 'default',
				// opens the add dialog registered by +page.svelte
				actionId: 'friends:create'
			}
		]
	};
};
