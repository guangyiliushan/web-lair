import { expect, test, type Page } from '@playwright/test';
import { expectNoCriticalAxe, psql } from './support';
import { zhCnLocale } from './locale-fixture';

/**
 * A3: every admin search field has a real accessible name.
 *
 * The failure mode this pins is "the input has a placeholder and nothing
 * else" — a searchbox with no name is invisible to a screen reader's element
 * list and to voice control. The fix is a `sr-only` <label for> (not
 * `aria-label`), so `toHaveAccessibleName` is the assertion that matters; the
 * axe gate on /admin/readers is the project-wide backstop.
 *
 * The localhost origin auto-authenticates as the site owner (TAILSCALE_ALLOW_LOOPBACK).
 */
const CATEGORY = '00000000-0000-7000-8000-000000000050';
const CATEGORY_NAME = 'E2E Search Cat';
const TOPIC = '00000000-0000-7000-8000-000000000051';
const TOPIC_NAME = 'E2E Search Topic';
const POST_HIT_ID = '00000000-0000-7000-8000-000000000052';
const POST_MISS_ID = '00000000-0000-7000-8000-000000000053';
const NOTE_HIT_ID = '00000000-0000-7000-8000-000000000054';
const NOTE_MISS_ID = '00000000-0000-7000-8000-000000000055';
const POST_HIT = 'E2E Filter Alpha';
const POST_MISS = 'E2E Filter Beta';
const NOTE_HIT = 'E2E Note Alpha';
const NOTE_MISS = 'E2E Note Beta';

// Copy from messages/zh-cn.json — the spec pins zh-cn so the names are stable.
const NAME_LIST = '搜索';
const NAME_READERS = '搜索读者';
const NAME_WORKSPACE = '搜索文章';
const NO_RESULTS = '没有匹配的结果';

test.use(zhCnLocale);
test.describe.configure({ timeout: 120_000 });

function cleanup(): void {
	psql(`delete from posts where id in ('${POST_HIT_ID}', '${POST_MISS_ID}')`);
	psql(`delete from notes where id in ('${NOTE_HIT_ID}', '${NOTE_MISS_ID}')`);
	psql(`delete from categories where id = '${CATEGORY}' or slug = 'e2e-search-cat'`);
	psql(`delete from topics where id = '${TOPIC}' or slug = 'e2e-search-topic'`);
}

test.beforeAll(() => {
	cleanup();
	psql(
		`insert into categories (id, name, slug) values ('${CATEGORY}', '${CATEGORY_NAME}', 'e2e-search-cat')
		 on conflict (id) do update set name = excluded.name, slug = excluded.slug`
	);
	psql(
		`insert into topics (id, name, slug) values ('${TOPIC}', '${TOPIC_NAME}', 'e2e-search-topic')
		 on conflict (id) do update set name = excluded.name, slug = excluded.slug`
	);
	psql(
		`insert into posts (id, title, slug, category_id) values
		 ('${POST_HIT_ID}', '${POST_HIT}', 'e2e-filter-alpha', '${CATEGORY}'),
		 ('${POST_MISS_ID}', '${POST_MISS}', 'e2e-filter-beta', '${CATEGORY}')`
	);
	psql(
		`insert into notes (id, title, slug, topic_id) values
		 ('${NOTE_HIT_ID}', '${NOTE_HIT}', 'e2e-note-filter-alpha', '${TOPIC}'),
		 ('${NOTE_MISS_ID}', '${NOTE_MISS}', 'e2e-note-filter-beta', '${TOPIC}')`
	);
});

test.afterAll(() => {
	cleanup();
});

/** The one search field on the page: `role=searchbox` is `type="search"`. */
function searchbox(page: Page) {
	return page.getByRole('searchbox');
}

test('the list toolbar search (ListSearch) carries its label', async ({ page }) => {
	await page.goto('/admin/posts');
	await expect(searchbox(page)).toHaveAccessibleName(NAME_LIST, { timeout: 15000 });
});

test('the readers filter search is named', async ({ page }) => {
	await page.goto('/admin/readers');
	await expect(searchbox(page)).toHaveAccessibleName(NAME_READERS, { timeout: 15000 });
});

test('the category workspace search is named', async ({ page }) => {
	await page.goto(`/admin/posts/categories/${CATEGORY}`);
	await expect(searchbox(page)).toHaveAccessibleName(NAME_WORKSPACE, { timeout: 15000 });
});

test('the topic workspace search is named', async ({ page }) => {
	await page.goto(`/admin/notes/topics/${TOPIC}`);
	await expect(searchbox(page)).toHaveAccessibleName(NAME_WORKSPACE, { timeout: 15000 });
});

test('the readers list has no critical axe violations', async ({ page }) => {
	await page.goto('/admin/readers');
	await expect(searchbox(page)).toBeVisible({ timeout: 15000 });
	await expectNoCriticalAxe(page, 'admin-readers');
});

test('the category workspace search filters the post list', async ({ page }) => {
	await page.goto(`/admin/posts/categories/${CATEGORY}`);
	await expect(page.getByText(POST_HIT)).toBeVisible({ timeout: 15000 });
	await expect(page.getByText(POST_MISS)).toBeVisible();

	await searchbox(page).fill('alpha');
	await expect(page.getByText(POST_HIT)).toBeVisible();
	await expect(page.getByText(POST_MISS)).toHaveCount(0);

	// Clearing restores the full list.
	await searchbox(page).fill('');
	await expect(page.getByText(POST_MISS)).toBeVisible();
});

test('a category search with no match says so instead of "no posts"', async ({ page }) => {
	await page.goto(`/admin/posts/categories/${CATEGORY}`);
	await expect(page.getByText(POST_HIT)).toBeVisible({ timeout: 15000 });

	await searchbox(page).fill('zzzz-no-such-post');
	await expect(page.getByText(NO_RESULTS)).toBeVisible();
	await expect(page.getByText(POST_HIT)).toHaveCount(0);
});

test('the topic workspace search filters the note list', async ({ page }) => {
	await page.goto(`/admin/notes/topics/${TOPIC}`);
	await expect(page.getByText(NOTE_HIT)).toBeVisible({ timeout: 15000 });
	await expect(page.getByText(NOTE_MISS)).toBeVisible();

	await searchbox(page).fill('alpha');
	await expect(page.getByText(NOTE_HIT)).toBeVisible();
	await expect(page.getByText(NOTE_MISS)).toHaveCount(0);

	await searchbox(page).fill('');
	await expect(page.getByText(NOTE_MISS)).toBeVisible();
});

test('a topic search with no match says so instead of "no notes"', async ({ page }) => {
	await page.goto(`/admin/notes/topics/${TOPIC}`);
	await expect(page.getByText(NOTE_HIT)).toBeVisible({ timeout: 15000 });

	await searchbox(page).fill('zzzz-no-such-note');
	await expect(page.getByText(NO_RESULTS)).toBeVisible();
	await expect(page.getByText(NOTE_HIT)).toHaveCount(0);
});
