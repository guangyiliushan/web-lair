import { describe, expect, it } from 'vitest';
import { BUDGET_SAMPLES, tableBudget, tailwindPx } from './list-budget';
import type { ListColumn } from './list-column';
import { columns as drafts } from '../../../../routes/(admin)/admin/drafts/columns';
import { columns as files } from '../../../../routes/(admin)/admin/files/columns';
import { columns as friends } from '../../../../routes/(admin)/admin/friends/columns';
import { columns as ai } from '../../../../routes/(admin)/admin/ai/columns';
import { columns as moments } from '../../../../routes/(admin)/admin/moments/columns';
import { columns as notes } from '../../../../routes/(admin)/admin/notes/columns';
import { columns as pages } from '../../../../routes/(admin)/admin/pages/columns';
import { columns as posts } from '../../../../routes/(admin)/admin/posts/columns';

/** Viewport tier at which a column with this `hideBelow` appears. */
const TIER_START: Record<string, number> = {
	sm: 640,
	md: 768,
	lg: 1024,
	xl: 1280,
	'2xl': 1536
};

const LISTS: Array<[string, ListColumn[]]> = [
	['posts', posts as ListColumn[]],
	['notes', notes as ListColumn[]],
	['moments', moments as ListColumn[]],
	['drafts', drafts as ListColumn[]],
	['pages', pages as ListColumn[]],
	['files', files as ListColumn[]],
	['friends', friends as ListColumn[]],
	['ai', ai as ListColumn[]]
];

/** The one column that absorbs the leftover width. */
function flexibleOf(cols: ListColumn[]): ListColumn[] {
	return cols.filter((col) => !col.width || col.width.startsWith('min-w-'));
}

/** Width a column claims regardless of how much room is left. */
function fixedPx(col: ListColumn): number {
	return col.width && col.width.startsWith('w-') ? tailwindPx(col.width) : 0;
}

function flexMinPx(col: ListColumn): number {
	return col.width && col.width.startsWith('min-w-') ? tailwindPx(col.width) : 0;
}

function visibleAt(cols: ListColumn[], viewport: number): ListColumn[] {
	return cols.filter((col) => !col.hideBelow || TIER_START[col.hideBelow] <= viewport);
}

/**
 * The overlap guard, as arithmetic.
 *
 * A column set is only legal if, at every viewport where its columns are on,
 * the fixed widths still leave room for the flexible column. Tailwind's
 * breakpoints measure the viewport while the sidebar eats 256px of it, so a
 * set can be fine at 767px and over budget at 768px — which is exactly how
 * the title column got crushed to 6px and painted over its neighbour.
 *
 * These assertions are pure: no browser, no layout, just the numbers the
 * pages declare.
 */
describe('admin list width budget', () => {
	for (const [name, cols] of LISTS) {
		it(`${name}: exactly one flexible column`, () => {
			const flexible = flexibleOf(cols);
			expect(flexible, `${name} must have exactly one column without a fixed width`).toHaveLength(
				1
			);
		});

		it(`${name}: the flexible column has a floor`, () => {
			const [flexible] = flexibleOf(cols);
			expect(
				flexMinPx(flexible),
				`${name}.${flexible.id} needs a min-w-* so table-fixed can never crush it to zero`
			).toBeGreaterThan(0);
		});

		it(`${name}: every tier fits the measured table width`, () => {
			const violations: string[] = [];
			for (const viewport of BUDGET_SAMPLES) {
				const shown = visibleAt(cols, viewport);
				const fixed = shown.reduce((sum, col) => sum + fixedPx(col), 0);
				const floor = shown.reduce((sum, col) => sum + flexMinPx(col), 0);
				const budget = tableBudget(viewport);
				if (fixed + floor > budget) {
					violations.push(
						`${viewport}px: needs ${fixed + floor}px (${shown
							.map((c) => c.id)
							.join('+')}) but only ${budget}px is available`
					);
				}
			}
			expect(violations, `${name} overruns its width budget`).toEqual([]);
		});

		it(`${name}: widths are Tailwind tokens`, () => {
			for (const col of cols) {
				if (col.width) expect(() => tailwindPx(col.width!), `${name}.${col.id}`).not.toThrow();
			}
		});
	}
});
