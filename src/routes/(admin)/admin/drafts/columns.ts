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
	'title' | 'kind' | 'lang' | 'postStatus' | 'updated' | 'actions',
	ListColumn
> = {
	title: { id: 'title', label: m.admin_list_col_title(), width: 'min-w-32' },
	kind: { id: 'kind', label: m.admin_common_type(), width: 'w-16', hideBelow: 'md' },
	lang: { id: 'lang', label: m.admin_posts_edit_lang_label(), width: 'w-16', hideBelow: 'md' },
	postStatus: {
		id: 'postStatus',
		label: m.admin_drafts_col_post_status(),
		width: 'w-24',
		hideBelow: 'lg'
	},
	updated: { id: 'updated', label: m.admin_drafts_col_updated(), width: 'w-32', hideBelow: 'lg' },
	actions: { id: 'actions', label: m.admin_common_actions(), width: 'w-20', align: 'right' }
};

export const columns = Object.values(cols);
