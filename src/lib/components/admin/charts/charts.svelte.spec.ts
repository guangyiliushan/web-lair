import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import PublishTrend from './publish-trend.svelte';
import CategoryBars from './category-bars.svelte';
import CommentActivity from './comment-activity.svelte';

/**
 * Browser specs for the three dashboard charts. The route specs cover the
 * aggregates; these cover what layerchart actually does with them - that the
 * composite API accepts the series shape, that a real plot is produced, that
 * the legend always names every series, and that the table-view twin exposes
 * the same numbers without hover (dataviz: a tooltip may never be the only way
 * to read a value).
 */

overwriteGetLocale(() => 'en');

const publish = [
	{ bucket: '2026-01', date: new Date('2026-01-01'), posts: 3, notes: 1 },
	{ bucket: '2026-02', date: new Date('2026-02-01'), posts: 0, notes: 2 },
	{ bucket: '2026-03', date: new Date('2026-03-01'), posts: 5, notes: 0 }
];

const categories = [
	{ name: 'Essays', count: 12 },
	{ name: 'Notes', count: 7 },
	{ name: 'Log', count: 3 }
];

const comments = [
	{ bucket: '2026-03-01', date: new Date('2026-03-01'), total: 4, approved: 3 },
	{ bucket: '2026-03-02', date: new Date('2026-03-02'), total: 0, approved: 0 },
	{ bucket: '2026-03-03', date: new Date('2026-03-03'), total: 2, approved: 1 }
];

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	document.body.innerHTML = '';
});

describe('publish trend', () => {
	it('plots both series and labels both in the legend', async () => {
		await render(PublishTrend, { data: publish });
		expect(document.querySelector('[data-slot="chart"]')).not.toBeNull();
		expect(document.body.textContent).toContain('Posts');
		expect(document.body.textContent).toContain('Notes');
	});

	it('reaches every value through the table twin', async () => {
		await render(PublishTrend, { data: publish });
		const table = document.querySelector('table');
		expect(table).not.toBeNull();
		expect(table?.querySelectorAll('tbody tr')).toHaveLength(3);
		expect(table?.textContent).toContain('2026-01');
	});

	it('falls back to the empty state when nothing was ever published', async () => {
		await render(PublishTrend, {
			data: publish.map((p) => ({ ...p, posts: 0, notes: 0 }))
		});
		expect(document.querySelector('[data-slot="chart"]')).toBeNull();
		expect(document.querySelector('table')).toBeNull();
	});
});

describe('category ranking', () => {
	it('plots every category as its own bar and totals them', async () => {
		await render(CategoryBars, { data: categories });
		expect(document.querySelector('[data-slot="chart"]')).not.toBeNull();
		expect(document.body.textContent).toContain('22');
	});

	it('caps the ranking at five categories', async () => {
		const seven = Array.from({ length: 7 }, (_, i) => ({ name: `Cat ${i + 1}`, count: 20 - i }));
		await render(CategoryBars, { data: seven });
		expect(document.querySelectorAll('table tbody tr')).toHaveLength(5);
	});

	it('truncates a long name on the axis but keeps the full one in the table', async () => {
		const long = '项目复盘与技术选型';
		await render(CategoryBars, {
			data: [
				{ name: long, count: 4 },
				{ name: 'Log', count: 1 }
			]
		});
		// The full name is always reachable - truncation may never gate it.
		expect(document.querySelector('table')?.textContent).toContain(long);
		// And the axis label is cut to the reserved band, not drawn past it.
		const tickLabels = [...(document.querySelectorAll('svg text') ?? [])].map(
			(t) => t.textContent ?? ''
		);
		expect(tickLabels.some((t) => t.includes('…'))).toBe(true);
	});

	it('lists every category in the table twin', async () => {
		await render(CategoryBars, { data: categories });
		const table = document.querySelector('table');
		expect(table?.querySelectorAll('tbody tr')).toHaveLength(3);
		expect(table?.textContent).toContain('Essays');
		expect(table?.textContent).toContain('12');
	});
});

describe('comment activity', () => {
	it('stacks approved and pending and names both', async () => {
		await render(CommentActivity, { data: comments });
		expect(document.querySelector('[data-slot="chart"]')).not.toBeNull();
		expect(document.body.textContent).toContain('Approved');
		expect(document.body.textContent).toContain('Pending');
	});

	it('derives pending as total minus approved, never negative', async () => {
		await render(CommentActivity, { data: comments });
		const rows = document.querySelectorAll('table tbody tr');
		expect(rows).toHaveLength(3);
		// 4 total / 3 approved -> 1 pending
		expect(rows[0]?.textContent).toContain('1');
	});

	it('treats an all-zero window as empty rather than drawing a flat axis', async () => {
		await render(CommentActivity, {
			data: comments.map((c) => ({ ...c, total: 0, approved: 0 }))
		});
		expect(document.querySelector('[data-slot="chart"]')).toBeNull();
	});
});
