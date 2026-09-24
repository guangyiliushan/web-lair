import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	return {
		headerTitle: '草稿箱',
		headerActions: [{ label: '预览站点', iconName: 'eye', href: '/' }]
	};
};
