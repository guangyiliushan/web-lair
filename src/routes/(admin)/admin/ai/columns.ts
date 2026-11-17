import { m } from '$lib/paraglide/messages';
import type { ListColumn } from '$lib/components/admin/list-table';

/**
 * Column set for the AI activity ledger. It lives beside the page but outside it so
 * `list-budget.test.ts` can check the width arithmetic without rendering.
 * The tiers below are the answer to that test: fixed widths plus the flexible column's
 * minimum must fit `tableBudget(v)` at all twelve sample viewports. 768px is the tightest
 * tier by far (121px spare), where the sidebar comes into flow and the budget drops from 719
 * to 433 — the cliff `list-budget.ts` documents.
 * Order is display order, not tier order: narrowing drops columns, it never reorders them.
 * Filters live in their own column's `<th>` (see `control`), so the most-filtered columns
 * survive to the widest tiers.
 * The time column carries the date as well as the clock, like every audit table people
 * already read (Stripe, Datadog, GitHub Actions); a day-group rule would save width but fight
 * the shared row height.
 */
export const cols: Record<
	'time' | 'task' | 'model' | 'status' | 'related' | 'tokens' | 'duration' | 'cost',
	ListColumn
> = {
	time: { id: 'time', label: m.admin_ai_col_time(), width: 'w-24' },
	task: { id: 'task', label: m.admin_ai_col_task(), width: 'w-20', control: true },
	model: {
		id: 'model',
		label: m.admin_ai_col_model(),
		width: 'w-48',
		hideBelow: 'lg',
		control: true
	},
	status: {
		id: 'status',
		label: m.admin_common_status(),
		width: 'w-20',
		hideBelow: 'lg',
		control: true
	},
	related: { id: 'related', label: m.admin_ai_col_related(), width: 'min-w-16' },
	tokens: {
		id: 'tokens',
		label: m.admin_ai_col_tokens(),
		width: 'w-20',
		hideBelow: 'xl',
		align: 'right'
	},
	duration: {
		id: 'duration',
		label: m.admin_ai_col_duration(),
		width: 'w-16',
		hideBelow: 'xl',
		align: 'right'
	},
	cost: {
		id: 'cost',
		label: m.admin_ai_col_cost(),
		width: 'w-20',
		hideBelow: 'sm',
		align: 'right'
	}
};

export const columns = Object.values(cols);
