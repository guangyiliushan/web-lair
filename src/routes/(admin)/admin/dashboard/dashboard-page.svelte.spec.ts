import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import AdminDashboard from './+page.svelte';

/**
 * Page-shape specs for the admin dashboard. The 2026-10-21 rework removed six
 * permanently empty panels and four buttons that had no handler at all (the
 * cache / search-index cards). These pin the result: every control on the page
 * does something, the charts that do have aggregates are present, and the ones
 * that never had a data source are gone for good.
 */

overwriteGetLocale(() => 'en');

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	readyState = 0;
	readonly url: string;
	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}
	addEventListener() {}
	close() {
		this.readyState = 2;
	}
}

vi.stubGlobal('EventSource', FakeEventSource);

function mount(extra: Record<string, unknown> = {}) {
	return render(AdminDashboard, {
		data: {
			headerTitle: 'Dashboard',
			counts: { posts: 7, notes: 3, quotes: 2, thoughts: 5, moments: 1 },
			stats: {
				pages: 10,
				categories: 7,
				comments: 2418,
				commentsUnread: 1,
				friends: 55,
				friendRequests: 8,
				characters: 4000,
				reads: 0,
				likes: 0
			},
			charts: {
				publish: [
					{ bucket: '2026-01', date: new Date('2026-01-01'), posts: 3, notes: 1 },
					{ bucket: '2026-02', date: new Date('2026-02-01'), posts: 0, notes: 2 }
				],
				categories: [
					{ name: 'Essays', count: 12 },
					{ name: 'Log', count: 3 }
				],
				comments: [{ bucket: '2026-03-01', date: new Date('2026-03-01'), total: 4, approved: 3 }]
			},
			lastAdminLogin: null,
			siteTimezone: 'UTC',
			auth: null,
			presence: { enabled: false, site: null, day: null, peak: null },
			...extra
		} as never
	});
}

beforeEach(() => {
	document.body.innerHTML = '';
	FakeEventSource.instances.length = 0;
});

afterEach(() => {
	document.body.innerHTML = '';
});

describe('admin dashboard page shape', () => {
	it('renders the three charts that have real aggregates', async () => {
		await mount();
		expect(document.querySelectorAll('[data-slot="chart"]')).toHaveLength(3);
	});

	it('offers no control without a handler: no bare buttons left over', async () => {
		await mount();
		// Every button on this page is either a link or wired to the reload
		// action. A button with neither is the bug this rework removed.
		const bare = [...document.querySelectorAll('button')].filter((b) => {
			const label = b.textContent ?? '';
			return (
				label.includes('Clear') ||
				label.includes('rebuild') ||
				label.includes('Force') ||
				label.includes('Incremental')
			);
		});
		expect(bare).toEqual([]);
	});

	it('drops the panels that never had a data source', async () => {
		await mount();
		const text = document.body.textContent ?? '';
		expect(text).not.toContain('Traffic sources');
		expect(text).not.toContain('Popular posts');
		expect(text).not.toContain('Tag cloud');
		expect(text).not.toContain('Cache management');
		expect(text).not.toContain('Search index');
	});

	it('points at the maintenance surface instead of dead cache controls', async () => {
		await mount();
		const link = document.querySelector('a[href="/admin/maintenance"]');
		expect(link).not.toBeNull();
		expect(link?.getAttribute('href')).toBe('/admin/maintenance');
	});

	it('packs quick actions into columns above md and keeps one row per item below it', async () => {
		await mount();
		const grid = [...document.querySelectorAll('ul')].find((u) => u.querySelectorAll('li').length === 5);
		expect(grid).not.toBeNull();
		// The single markup serves both layouts: one column on the phone (which
		// the design keeps as-is), then 2 / 3 / 5 columns as the canvas widens.
		for (const step of ['grid-cols-1', 'md:grid-cols-2', 'lg:grid-cols-3', 'xl:grid-cols-5']) {
			expect(grid?.className).toContain(step);
		}
		// Cells must be free to drop the button pair onto a second line, or a
		// five-across xl row would squeeze "Write" / "Manage" into nothing.
		const cells = [...(grid?.querySelectorAll('li') ?? [])];
		expect(cells).toHaveLength(5);
		for (const cell of cells) {
			expect(cell.className).toContain('flex-wrap');
			expect(cell.querySelectorAll('a')).toHaveLength(2);
		}
	});

	it('keeps the quick-action rows as real navigation', async () => {
		await mount();
		const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
		expect(hrefs).toContain('/admin/posts/edit');
		expect(hrefs).toContain('/admin/quotes?add=1');
		expect(hrefs).toContain('/admin/moments');
	});
});
