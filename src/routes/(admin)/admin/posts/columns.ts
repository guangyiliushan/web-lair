import { m } from '$lib/paraglide/messages';
import type { ListColumn } from '$lib/components/admin/list-table';

/**
 * Column set for this admin list. Lives beside the page but outside it so
 * `list-budget.test.ts` can check the width arithmetic without rendering.
 *
 * `width` is the Tailwind token the `<th>` gets; `hideBelow` is the viewport
 * tier at which the column appears. Every tier must stay inside the measured
 * table budget - see `list-budget.ts` for why the sidebar makes that tight.
 *
 * Order below is display order and must not follow the tiers: narrowing
 * drops columns, it never reorders them. A filter column is deliberately
 * tiered later than plain data, so the more used a filter is the longer
 * it survives.
 */
export const cols: Record<
	'title' | 'category' | 'status' | 'views' | 'likes' | 'updated' | 'actions',
	ListColumn
> = {
	title: { id: 'title', label: m.admin_list_col_title(), width: 'min-w-32', control: true },
	category: {
		id: 'category',
		label: m.admin_list_col_category(),
		width: 'w-28',
		hideBelow: 'lg',
		control: true
	},
	status: {
		id: 'status',
		label: m.admin_common_status(),
		width: 'w-24',
		hideBelow: 'md',
		control: true
	},
	views: {
		id: 'views',
		label: m.admin_list_col_views(),
		width: 'w-16',
		hideBelow: 'xl',
		align: 'right'
	},
	likes: {
		id: 'likes',
		label: m.admin_list_col_likes(),
		width: 'w-16',
		hideBelow: 'xl',
		align: 'right'
	},
	updated: { id: 'updated', label: m.admin_list_col_updated(), width: 'w-32', hideBelow: 'lg' },
	actions: {
		id: 'actions',
		label: m.admin_common_actions(),
		width: 'w-28',
		align: 'right',
		control: true
	}
};

export const columns = Object.values(cols);
