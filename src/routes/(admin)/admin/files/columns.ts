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
	'preview' | 'file' | 'dimensions' | 'size' | 'status' | 'refs' | 'uploaded' | 'actions',
	ListColumn
> = {
	preview: {
		id: 'preview',
		label: m.admin_files_col_preview(),
		width: 'w-24',
		hideBelow: 'lg',
		control: true
	},
	file: { id: 'file', label: m.admin_files_kind_file(), width: 'min-w-32', control: true },
	dimensions: {
		id: 'dimensions',
		label: m.admin_files_col_dimensions(),
		width: 'w-24',
		hideBelow: 'xl'
	},
	size: { id: 'size', label: m.admin_files_col_size(), width: 'w-24', hideBelow: 'lg' },
	status: {
		id: 'status',
		label: m.admin_common_status(),
		width: 'w-24',
		hideBelow: 'md',
		control: true
	},
	refs: {
		id: 'refs',
		label: m.admin_files_col_refs(),
		width: 'w-24',
		hideBelow: '2xl',
		control: true
	},
	uploaded: {
		id: 'uploaded',
		label: m.admin_files_col_uploaded(),
		width: 'w-40',
		hideBelow: 'xl',
		control: true
	},
	actions: {
		id: 'actions',
		label: m.admin_common_actions(),
		width: 'w-28',
		align: 'right',
		control: true
	}
};

export const columns = Object.values(cols);
