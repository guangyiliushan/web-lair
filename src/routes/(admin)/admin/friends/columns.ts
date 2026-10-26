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
 * columns, it never reorders them. This list has no column-level filters (the
 * state switch is the ToggleGroup bar above the table), so the tiers follow
 * plain data importance: identity first, then what the friend is (description,
 * url), then metadata.
 */
export const cols: Record<
	'name' | 'description' | 'url' | 'type' | 'email' | 'created' | 'actions',
	ListColumn
> = {
	name: { id: 'name', label: m.admin_friends_col_name(), width: 'min-w-32' },
	description: {
		id: 'description',
		label: m.admin_friends_col_description(),
		width: 'w-44',
		hideBelow: 'lg'
	},
	url: { id: 'url', label: m.admin_friends_col_url(), width: 'w-40', hideBelow: 'xl' },
	type: { id: 'type', label: m.admin_common_type(), width: 'w-24', hideBelow: 'md' },
	email: { id: 'email', label: m.admin_friends_col_email(), width: 'w-40', hideBelow: '2xl' },
	created: {
		id: 'created',
		label: m.admin_friends_col_created(),
		width: 'w-28',
		hideBelow: 'xl'
	},
	actions: {
		id: 'actions',
		label: m.admin_common_actions(),
		width: 'w-28',
		align: 'right'
	}
};

export const columns = Object.values(cols);
