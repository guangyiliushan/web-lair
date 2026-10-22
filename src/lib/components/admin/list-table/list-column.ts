/**
 * Column descriptor for the shared admin list surface (posts / notes / moments).
 *
 * One array is the single source of truth: `listColumnClass` derives both the
 * `<th>` and the `<td>` class from it, so a column can never be visible in the
 * body while its head is hidden (the bug that made the old `table-fixed` lists
 * collapse and overlap).
 */
export type ListColumnHide = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

export type ListColumn = {
	id: string;
	/** Column heading. Also the accessible name when the head shows a control. */
	label: string;
	/**
	 * Width class for the `<th>`. Under `table-layout: fixed` the head row
	 * decides the widths, so exactly one column should omit this and absorb
	 * the remaining space.
	 */
	width?: string;
	/** Hide the column (head + cells) below this breakpoint. */
	hideBelow?: ListColumnHide;
	/** Right-align the header label and the cells (actions column). */
	align?: 'right';
	/**
	 * The head cell hosts a control (search / filter / refresh) instead of the
	 * plain label. Controls are rendered by the `header` snippet of
	 * `list-table.svelte`; the label stays as an `sr-only` name.
	 */
	control?: boolean;
};

const HIDE: Record<ListColumnHide, string> = {
	sm: 'hidden sm:table-cell',
	md: 'hidden md:table-cell',
	lg: 'hidden lg:table-cell',
	xl: 'hidden xl:table-cell',
	'2xl': 'hidden 2xl:table-cell'
};

/**
 * Class fragment shared by a column's `<th>` and every `<td>` in it: the
 * width plus the responsive hide rule.
 */
export function listColumnClass(column: ListColumn): string {
	return [column.width, column.hideBelow ? HIDE[column.hideBelow] : null].filter(Boolean).join(' ');
}

/** Class fragment for a column's `<th>`, adding the alignment. */
export function listHeadClass(column: ListColumn): string {
	return [listColumnClass(column), 'align-middle', column.align === 'right' && 'text-right']
		.filter(Boolean)
		.join(' ');
}
