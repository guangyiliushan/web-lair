import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ListTableFixture from './list-table.fixture.svelte';

/**
 * Pins the shared admin list surface (posts / notes / moments): the head and
 * every cell of a column carry the same width + responsive-hide class, so the
 * grid cannot drift apart at a breakpoint, and each filter control lives in
 * the `<th>` of the column it drives. The pre-shared lists hand-wrote widths
 * on the `<td>`s, shipped no `<thead>` at all and floated the toolbar with a
 * spacer `<div class="w-20">` — which is what made them overlap and misalign.
 */

const COLS = [
	{ id: 'title', hide: [] as string[], control: 'search' },
	{ id: 'status', hide: ['hidden', 'md:table-cell'], control: 'filter' },
	{ id: 'views', hide: ['hidden', 'xl:table-cell'], control: null },
	{ id: 'actions', hide: [], control: 'refresh' }
];

function classes(el: Element | null | undefined): string[] {
	return (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

async function mount(rows: { id: string; title: string; status: string; views: number }[] = []) {
	return render(ListTableFixture, { rows });
}

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	document.body.innerHTML = '';
});

describe('admin list table', () => {
	it('keeps the head and the cells of a column in the same responsive class', async () => {
		await mount([{ id: 'a', title: 'First', status: 'published', views: 3 }]);

		const heads = document.querySelectorAll('thead th');
		const cells = document.querySelectorAll('tbody tr td');
		expect(heads).toHaveLength(COLS.length);
		expect(cells).toHaveLength(COLS.length);

		COLS.forEach((col, index) => {
			const head = classes(heads[index]);
			const cell = classes(cells[index]);
			for (const token of col.hide) {
				expect(head, `${col.id} th`).toContain(token);
				expect(cell, `${col.id} td`).toContain(token);
			}
		});
	});

	it('hosts each filter control in the head cell of the column it drives', async () => {
		await mount();

		const heads = document.querySelectorAll('thead th');
		for (const [index, col] of COLS.entries()) {
			for (const name of ['search', 'filter', 'refresh']) {
				const found = heads[index].querySelector(`[data-testid="${name}"]`);
				expect(
					Boolean(found),
					`${col.id} should ${col.control === name ? '' : 'not '}host ${name}`
				).toBe(col.control === name);
			}
		}
	});

	it('renders the empty state in one full-width cell', async () => {
		await mount();

		const cell = document.querySelector('tbody td');
		expect(cell?.getAttribute('colspan')).toBe(String(COLS.length));
		expect(document.querySelector('[data-testid="empty"]')).not.toBeNull();
	});
});
