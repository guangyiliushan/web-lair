import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { m } from '$lib/paraglide/messages';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import NotePagination from './NotePagination.svelte';

// Pin the UI locale for copy assertions (official paraglide escape hatch,
// mirrors comment-threads.svelte.spec.ts).
overwriteGetLocale(() => 'zh-cn');

// perPage flows through to Pagination.Root (context only - nothing
// page-count-related is rendered yet; the review-round-2 mutation probe
// showed a hardcoded perPage is DOM-invisible until Page items land).
const href = (target: number) => `/notes?page=${target}`;

async function linkHref(name: string): Promise<string | null> {
	return (await page.getByRole('link', { name }).element()).getAttribute('href');
}

describe('NotePagination', () => {
	it('renders nothing while a single page remains', async () => {
		await render(NotePagination, { page: 1, totalPages: 1, total: 5, perPage: 5, href });
		expect(document.body.querySelector('nav')).toBeNull();
	});

	it('links prev/next through the caller href targets', async () => {
		await render(NotePagination, { page: 2, totalPages: 3, total: 12, perPage: 5, href });
		expect(await linkHref(m.pagination_previous())).toMatch(/[?&]page=1(?:&|$)/);
		expect(await linkHref(m.pagination_next())).toMatch(/[?&]page=3(?:&|$)/);
		expect(document.body.querySelector('nav[aria-label="Pagination"]')).not.toBeNull();
		expect(document.body.textContent).toContain(
			m.pagination_page({ page: String(2), total: String(3) })
		);
	});

	it('disables prev on the first page', async () => {
		await render(NotePagination, { page: 1, totalPages: 2, total: 6, perPage: 3, href });
		const prev = page.getByRole('button', { name: m.pagination_previous() });
		await expect.element(prev).toBeInTheDocument();
		expect((prev.element() as Element).hasAttribute('disabled')).toBe(true);
		expect(await linkHref(m.pagination_next())).toMatch(/[?&]page=2(?:&|$)/);
	});

	it('disables next on the last page', async () => {
		await render(NotePagination, { page: 2, totalPages: 2, total: 6, perPage: 3, href });
		const next = page.getByRole('button', { name: m.pagination_next() });
		await expect.element(next).toBeInTheDocument();
		expect((next.element() as Element).hasAttribute('disabled')).toBe(true);
		expect(await linkHref(m.pagination_previous())).toMatch(/[?&]page=1(?:&|$)/);
	});
});
