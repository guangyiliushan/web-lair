import { describe, expect, it } from 'vitest';
import { listColumnClass, listHeadClass, type ListColumn } from './list-column';

/**
 * The alignment contract for every admin list (posts / notes / moments): the
 * `<th>` and each `<td>` in a column are classed from the same descriptor, so
 * a column can never be half-hidden or half-width. The old lists hand-wrote
 * widths on the cells and left the head unstyled, which is what made them
 * collapse and overlap.
 */
describe('list column classes', () => {
	const column: ListColumn = {
		id: 'status',
		label: 'Status',
		width: 'w-28',
		hideBelow: 'md',
		align: 'right'
	};

	it('shares width and hide rules between head and cells', () => {
		expect(listColumnClass(column)).toBe('w-28 hidden md:table-cell');
		expect(listHeadClass(column)).toContain(listColumnClass(column));
	});

	it('omits the hide rule when a column is always visible', () => {
		const always: ListColumn = { id: 'title', label: 'Title' };
		expect(listColumnClass(always)).toBe('');
		expect(listHeadClass(always)).toBe('align-middle');
	});

	it('right-aligns only the head of an actions column', () => {
		expect(listHeadClass(column)).toContain('text-right');
		expect(listColumnClass(column)).not.toContain('text-right');
	});

	it('maps every breakpoint to its matching table-cell display class', () => {
		const expected: Record<string, string> = {
			sm: 'hidden sm:table-cell',
			md: 'hidden md:table-cell',
			lg: 'hidden lg:table-cell',
			xl: 'hidden xl:table-cell',
			'2xl': 'hidden 2xl:table-cell'
		};
		for (const [hideBelow, cls] of Object.entries(expected)) {
			expect(
				listColumnClass({ id: 'x', label: 'X', hideBelow: hideBelow as never }),
				hideBelow
			).toBe(cls);
		}
	});
});
