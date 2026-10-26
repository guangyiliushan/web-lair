import { m } from '$lib/paraglide/messages';
import type { ListColumn } from '$lib/components/admin/list-table';

/**
 * Column set for the friends list. Lives beside the page but outside it so
 * `list-budget.test.ts` can check the width arithmetic without rendering.
 *
 * `width` is the Tailwind token the `<th>` gets; `hideBelow` is the viewport
 * tier at which the column appears. Every tier must stay inside the measured
 * table budget - see `list-budget.ts` for why the sidebar makes that tight.
 *
 * Order below is display order and must not follow the tiers: narrowing drops
 * columns, it never reorders them. Identity first (name + host + description
 * subtitle), then the two signals a review actually reads (backlink, health),
 * then contact/time, then actions. `type` is gone: the table never had such a
 * column (plan §2.1), only the mock did.
 */
export const cols: Record<
	'name' | 'backlink' | 'health' | 'email' | 'time' | 'actions',
	ListColumn
> = {
	name: { id: 'name', label: m.admin_friends_col_name(), width: 'min-w-32' },
	backlink: {
		id: 'backlink',
		label: m.admin_friends_col_backlink(),
		width: 'w-28',
		hideBelow: 'md'
	},
	health: { id: 'health', label: m.admin_friends_col_health(), width: 'w-28', hideBelow: 'xl' },
	email: { id: 'email', label: m.admin_friends_col_email(), width: 'w-40', hideBelow: '2xl' },
	time: { id: 'time', label: m.admin_friends_col_time(), width: 'w-28', hideBelow: 'xl' },
	actions: {
		id: 'actions',
		label: m.admin_common_actions(),
		width: 'w-28',
		align: 'right'
	}
};

export const columns = Object.values(cols);
