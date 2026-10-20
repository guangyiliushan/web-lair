import { expect, test, type Page } from '@playwright/test';
import { psql } from './support';

/**
 * Sorting teeth (bounded UI batch): order is server-side, the pinned card is
 * latest-only, and oldest/updated must not let a pin jump the queue.
 *
 * Fixtures live in `ja` so the en/zh-cn specs that share the dev database
 * (notably post-p3a-routing's global "Pinned" locator) never see them. Ids are
 * generated per run; cleanup is prefix-scoped.
 */

const CATEGORY_SLUG = 'e2e-sort-cat';
const PREFIX = 'e2e-sort-';
const T_NEWEST = 'Sort newest';
const T_OLDEST = 'Sort oldest';
const T_UPDATED = 'Sort updated';
const T_PINNED = 'Sort pinned';
const T_NULL_UPDATED = 'Sort null-updated';
const filler = (n: number) => `Sort filler ${String(n).padStart(2, '0')}`;

type Fixture = {
	slug: string;
	title: string;
	publishedDays: number;
	updatedSql: string;
	pinSql: string;
	writingOrigin?: 'none' | 'assist' | 'mostly_ai' | 'ai_full';
};

const FIXTURES: Fixture[] = [
	{
		slug: 'newest',
		title: T_NEWEST,
		publishedDays: 1,
		updatedSql: `now() - interval '1 day'`,
		pinSql: 'null',
		writingOrigin: 'none'
	},
	{
		slug: 'pinned',
		title: T_PINNED,
		publishedDays: 2,
		updatedSql: `now() - interval '3 hours'`,
		pinSql: 'now()',
		writingOrigin: 'mostly_ai'
	},
	{
		slug: 'filler-01',
		title: filler(1),
		publishedDays: 3,
		updatedSql: `now() - interval '1 day 2 hours'`,
		pinSql: 'null'
	},
	{
		slug: 'filler-02',
		title: filler(2),
		publishedDays: 4,
		updatedSql: `now() - interval '1 day 4 hours'`,
		pinSql: 'null'
	},
	{
		slug: 'updated',
		title: T_UPDATED,
		publishedDays: 5,
		updatedSql: `now() - interval '1 hour'`,
		pinSql: 'null',
		writingOrigin: 'assist'
	},
	{
		slug: 'filler-03',
		title: filler(3),
		publishedDays: 6,
		updatedSql: `now() - interval '2 days'`,
		pinSql: 'null'
	},
	{
		slug: 'filler-04',
		title: filler(4),
		publishedDays: 7,
		updatedSql: `now() - interval '2 days 2 hours'`,
		pinSql: 'null'
	},
	{
		slug: 'filler-05',
		title: filler(5),
		publishedDays: 8,
		updatedSql: `now() - interval '2 days 4 hours'`,
		pinSql: 'null'
	},
	{
		slug: 'null-updated',
		title: T_NULL_UPDATED,
		publishedDays: 9,
		updatedSql: 'null',
		pinSql: 'null'
	},
	{
		slug: 'filler-06',
		title: filler(6),
		publishedDays: 10,
		updatedSql: `now() - interval '3 days'`,
		pinSql: 'null'
	},
	{
		slug: 'filler-07',
		title: filler(7),
		publishedDays: 11,
		updatedSql: `now() - interval '4 days'`,
		pinSql: 'null'
	},
	{
		slug: 'oldest',
		title: T_OLDEST,
		publishedDays: 12,
		updatedSql: `now() - interval '5 days'`,
		pinSql: 'null',
		writingOrigin: 'ai_full'
	},
	{
		slug: 'filler-08',
		title: filler(8),
		publishedDays: 13,
		updatedSql: `now() - interval '6 days'`,
		pinSql: 'null'
	}
];

// PAGE_SIZE is 10. Only a latest-order page 1 drops the pinned card from the
// list, so it lists 9 items; every other page lists 10 (or the remainder).
const LATEST_PAGE1 = [
	T_NEWEST,
	filler(1),
	filler(2),
	T_UPDATED,
	filler(3),
	filler(4),
	filler(5),
	T_NULL_UPDATED,
	filler(6)
];
const LATEST_PAGE2 = [filler(7), T_OLDEST, filler(8)];
const OLDEST_PAGE1 = [
	filler(8),
	T_OLDEST,
	filler(7),
	filler(6),
	T_NULL_UPDATED,
	filler(5),
	filler(4),
	filler(3),
	T_UPDATED,
	filler(2)
];
const OLDEST_PAGE2 = [filler(1), T_PINNED, T_NEWEST];
const UPDATED_PAGE1 = [
	T_UPDATED,
	T_PINNED,
	T_NEWEST,
	filler(1),
	filler(2),
	filler(3),
	filler(4),
	filler(5),
	filler(6),
	filler(7)
];

function cleanup(): void {
	psql(`delete from posts where slug like '${PREFIX}%'`);
	psql(`delete from categories where slug = '${CATEGORY_SLUG}'`);
}

test.beforeAll(() => {
	cleanup();
	psql(
		`insert into categories (id, name, slug) values (gen_random_uuid(), 'E2E Sort', '${CATEGORY_SLUG}')`
	);
	const category = `(select id from categories where slug = '${CATEGORY_SLUG}')`;
	const values = FIXTURES.map(
		(row) =>
			`(gen_random_uuid(), '${PREFIX}${row.slug}', '${row.title}', 'x', 'ja', 'published', now() - interval '${row.publishedDays} days', ${row.updatedSql}, ${category}, gen_random_uuid(), ${row.pinSql}, ${row.writingOrigin ? `'${row.writingOrigin}'` : 'null'})`
	).join(', ');
	psql(
		`insert into posts (id, slug, title, content, lang, status, published_at, updated_at, category_id, translation_group, pin_at, writing_origin) values ${values}`
	);
});

test.afterAll(() => {
	cleanup();
});

async function sortTitles(page: Page): Promise<string[]> {
	const titles = await page
		.getByTestId('post-list')
		.locator('[data-testid="post-list-item"] h3')
		.allTextContents();
	return titles.map((title) => title.trim());
}

async function expectOnlyCurrent(page: Page, label: string): Promise<void> {
	const current = page.getByTestId('post-sort').locator('[aria-current="true"]');
	await expect(current).toHaveCount(1);
	await expect(current).toHaveText(label);
}

async function expectCanonicalPath(page: Page, pathAndQuery: string): Promise<void> {
	const href = await page.locator('link[rel="canonical"]').getAttribute('href');
	expect(href).not.toBeNull();
	const url = new URL(href as string);
	expect(url.pathname + url.search).toBe(pathAndQuery);
}

test.describe('posts list sorting', () => {
	test('filter and sort controls share one plain-text row', async ({ page }) => {
		await page.goto('/ja/posts');

		await expect(page.getByTestId('post-ai-filter')).toBeVisible();

		const layout = await page.evaluate(() => {
			const countEl = document.querySelector('[data-testid="post-count"]');
			const filterEl = document.querySelector('[data-testid="post-ai-filter"]');
			const sortEl = document.querySelector('[data-testid="post-sort"]');
			if (!countEl || !filterEl || !sortEl) return null;
			const active = sortEl.querySelector('[aria-current="true"]');
			const idle = sortEl.querySelector('a:not([aria-current="true"])');
			const radius = (el: Element) => Number.parseFloat(getComputedStyle(el).borderTopLeftRadius);
			return {
				countLeftOfControls:
					countEl.getBoundingClientRect().right <= filterEl.getBoundingClientRect().left,
				sameRow: filterEl.parentElement === sortEl.parentElement,
				filterRadius: radius(filterEl),
				activeRadius: active ? radius(active) : null,
				activeDecoration: active ? getComputedStyle(active).textDecorationLine : null,
				activeWeight: active ? getComputedStyle(active).fontWeight : null,
				idleDecoration: idle ? getComputedStyle(idle).textDecorationLine : null
			};
		});

		if (!layout) throw new Error('post list controls not found');

		expect(layout.countLeftOfControls).toBe(true);
		expect(layout.sameRow).toBe(true);
		expect(layout.filterRadius).toBeLessThan(8);
		expect(layout.activeRadius).toBeLessThan(8);
		expect(layout.activeDecoration).toContain('underline');
		expect(layout.activeWeight).toBe('500');
		expect(layout.idleDecoration).not.toContain('underline');
	});

	test('default (latest) keeps the pinned card and newest-first order', async ({ page }) => {
		await page.goto('/ja/posts');

		await expect(page.getByTestId('pinned-card')).toContainText(T_PINNED);
		expect(await sortTitles(page)).toEqual(LATEST_PAGE1);
		await expectOnlyCurrent(page, 'Latest');
		await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
		await expectCanonicalPath(page, '/ja/posts');
		await expect(page.getByTestId('post-ai-filter')).toHaveAttribute(
			'href',
			'/ja/posts?ai=non-generated'
		);
		await expect(page.getByTestId('post-ai-filter')).not.toHaveAttribute('aria-current', 'true');
	});

	test('oldest is chronological and the pin does not jump the queue', async ({ page }) => {
		await page.goto('/ja/posts?sort=oldest');

		await expect(page.getByTestId('pinned-card')).toHaveCount(0);
		expect(await sortTitles(page)).toEqual(OLDEST_PAGE1);
		await expectOnlyCurrent(page, 'Oldest');
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');
		await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
		await expect(page.getByRole('link', { name: /Next page/i })).toHaveAttribute(
			'href',
			'/ja/posts?sort=oldest&page=2'
		);
	});

	test('updated sorts by mutable timestamp with NULLS LAST and shows Updated', async ({ page }) => {
		await page.goto('/ja/posts?sort=updated');

		expect(await sortTitles(page)).toEqual(UPDATED_PAGE1);
		const pinnedItem = page.locator('[data-testid="post-list-item"]').filter({ hasText: T_PINNED });
		await expect(pinnedItem.getByTestId('post-pinned-badge')).toBeVisible();
		await expect(page.getByTestId('post-list-item').first()).toContainText('Updated ');
	});

	test('page 2 keeps the sort and the pager; the pinned card is page-1 only', async ({ page }) => {
		await page.goto('/ja/posts?sort=oldest&page=2');

		expect(await sortTitles(page)).toEqual(OLDEST_PAGE2);
		await expect(page.getByTestId('pinned-card')).toHaveCount(0);
		const pinnedItem = page.locator('[data-testid="post-list-item"]').filter({ hasText: T_PINNED });
		await expect(pinnedItem.getByTestId('post-pinned-badge')).toBeVisible();
		await expect(page.getByRole('link', { name: /Previous page/i })).toHaveAttribute(
			'href',
			'/ja/posts?sort=oldest'
		);
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');
		await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);

		// Sort chips reset to page 1 when changing order.
		await expect(
			page.getByTestId('post-sort').getByRole('link', { name: 'Latest' })
		).toHaveAttribute('href', '/ja/posts');
		await expect(
			page.getByTestId('post-sort').getByRole('link', { name: 'Oldest' })
		).toHaveAttribute('href', '/ja/posts?sort=oldest');
	});

	test('default page 2 is self-canonical and has no pinned card', async ({ page }) => {
		await page.goto('/ja/posts?page=2');

		expect(await sortTitles(page)).toEqual(LATEST_PAGE2);
		await expect(page.getByTestId('pinned-card')).toHaveCount(0);
		await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
		await expectCanonicalPath(page, '/ja/posts?page=2');
	});

	test('unknown sort falls back to latest and is noindexed without a canonical', async ({
		page
	}) => {
		await page.goto('/ja/posts?sort=featured');

		expect(await sortTitles(page)).toEqual(LATEST_PAGE1);
		await expectOnlyCurrent(page, 'Latest');
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');
		await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
	});

	test('non-generated filter includes none/assist and excludes null/mostly/ai_full', async ({
		page
	}) => {
		await page.goto('/ja/posts?ai=non-generated');

		expect(await sortTitles(page)).toEqual([T_NEWEST, T_UPDATED]);
		await expect(page.getByTestId('post-ai-filter')).toHaveAttribute('href', '/ja/posts');
		await expect(page.getByTestId('post-ai-filter')).toHaveAttribute(
			'aria-label',
			'Show all posts (Not AI-generated filter active)'
		);
		await expect(page.getByText('2 posts')).toBeVisible();
		await expect(page.getByTestId('pinned-card')).toHaveCount(0);
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');
		await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
		await expect(
			page.getByTestId('post-sort').getByRole('link', { name: 'Oldest' })
		).toHaveAttribute('href', '/ja/posts?ai=non-generated&sort=oldest');

		await page.goto('/ja/posts?ai=non-generated&sort=oldest');
		expect(await sortTitles(page)).toEqual([T_UPDATED, T_NEWEST]);
		await expectOnlyCurrent(page, 'Oldest');

		await page.goto('/ja/posts?ai=non-generated&page=2');
		expect(await sortTitles(page)).toEqual([T_NEWEST, T_UPDATED]);
		await expect(page.getByRole('navigation', { name: 'Pagination' })).toHaveCount(0);
	});
});
