import { expect, test, type Page } from '@playwright/test';
import { psql } from './support';

/**
 * pages-line P2 acceptance (roadmap W3 #6, T6): the admin registry list and
 * the metadata editor against the real page and the real database. The
 * localhost origin auto-authenticates as the site owner (same as
 * auth.e2e.ts / TAILSCALE_ALLOW_LOOPBACK in the playwright webServer env).
 * Fixtures live under `e2e-admin-%` and are cleaned in beforeAll/afterAll.
 */

const SLUG_A = 'e2e-admin-a';
const SLUG_B = 'e2e-admin-b';
const TITLE_A = 'E2E Admin A';
const TITLE_A_ZH = 'E2E 管理页甲';
const TITLE_B = 'E2E Admin B';

let idA = '';
let idB = '';

test.describe.configure({ mode: 'serial' });

function cleanup(): void {
	psql(`delete from pages where slug like 'e2e-admin-%'`);
}

test.beforeAll(() => {
	cleanup();
	psql(
		`insert into pages (slug, title, description, icon, external_url, status, sort_order, is_default, content, content_format) values ('${SLUG_A}', '{"en":"${TITLE_A}","zh-cn":"${TITLE_A_ZH}"}'::jsonb, null, null, null, 'visible', 60, false, '{"en":"# E2E admin body A","zh-cn":"# E2E 管理页甲正文"}'::jsonb, 'markdown')`
	);
	psql(
		`insert into pages (slug, title, description, icon, external_url, status, sort_order, is_default, content, content_format) values ('${SLUG_B}', '{"en":"${TITLE_B}"}'::jsonb, null, null, null, 'visible', 61, false, '{"en":"# E2E admin body B"}'::jsonb, 'markdown')`
	);
	idA = psql(`select id from pages where slug = '${SLUG_A}'`);
	idB = psql(`select id from pages where slug = '${SLUG_B}'`);
});

test.afterAll(() => {
	cleanup();
});

function row(page: Page, text: string) {
	return page.getByRole('row').filter({ hasText: text });
}

async function rowIndex(page: Page, text: string): Promise<number> {
	return page.$$eval(
		'table tbody tr',
		(rows, needle) => rows.findIndex((r) => (r.textContent ?? '').includes(needle)),
		text
	);
}

const aFirst = async (page: Page) =>
	(await rowIndex(page, TITLE_A)) < (await rowIndex(page, TITLE_B));
const bFirst = async (page: Page) =>
	(await rowIndex(page, TITLE_B)) < (await rowIndex(page, TITLE_A));

test('the registry lists defaults first and tags the fixture rows', async ({ page }) => {
	await page.goto('/admin/pages');
	await expect(page.getByText(/共 \d+ 页/)).toBeVisible();
	await expect(row(page, TITLE_A)).toBeVisible();
	await expect(row(page, TITLE_B)).toBeVisible();
	await expect(row(page, 'About Me').getByText('默认')).toBeVisible();
	await expect(row(page, TITLE_A).getByText('默认')).toHaveCount(0);
	// "新增" stays with the P5 md editor — no header action here.
	await expect(page.getByRole('button', { name: '新建' })).toHaveCount(0);
});

test('▲/▼ reorders the fixture pair inside one list renumber', async ({ page }) => {
	await page.goto('/admin/pages');
	await expect(row(page, TITLE_A)).toBeVisible();
	await expect.poll(() => aFirst(page)).toBe(true);

	// Condition-guarded clicks: a hydration-swallowed first click retries
	// without ever double-toggling (the inner poll absorbs the invalidate).
	await expect(async () => {
		if (!(await bFirst(page))) {
			await row(page, TITLE_B).getByRole('button', { name: '上移' }).click();
		}
		await expect.poll(() => bFirst(page), { timeout: 8000 }).toBe(true);
	}).toPass({ timeout: 40_000 });

	await expect(async () => {
		if (!(await aFirst(page))) {
			await row(page, TITLE_B).getByRole('button', { name: '下移' }).click();
		}
		await expect.poll(() => aFirst(page), { timeout: 8000 }).toBe(true);
	}).toPass({ timeout: 40_000 });
});

test('the eye toggle flips a row between visible and hidden', async ({ page }) => {
	await page.goto('/admin/pages');
	const rowA = row(page, TITLE_A);
	await expect(rowA.getByText('可见')).toBeVisible();

	await expect(async () => {
		if ((await rowA.getByText('隐藏', { exact: true }).count()) === 0) {
			await rowA.getByRole('button', { name: '隐藏' }).click();
		}
		await expect
			.poll(() => rowA.getByText('隐藏', { exact: true }).isVisible(), {
				timeout: 8000
			})
			.toBe(true);
	}).toPass({ timeout: 40_000 });

	await expect(async () => {
		if ((await rowA.getByText('可见', { exact: true }).count()) === 0) {
			await rowA.getByRole('button', { name: '显示' }).click();
		}
		await expect
			.poll(() => rowA.getByText('可见', { exact: true }).isVisible(), {
				timeout: 8000
			})
			.toBe(true);
	}).toPass({ timeout: 40_000 });
});

test('default rows expose no delete and fold hiding behind a confirmation', async ({ page }) => {
	await page.goto('/admin/pages');
	const rowAbout = row(page, 'About Me');
	await expect(rowAbout).toBeVisible();
	await expect(rowAbout.getByRole('button', { name: '删除' })).toHaveCount(0);

	await expect(async () => {
		if ((await page.getByText('隐藏默认页？').count()) === 0) {
			await rowAbout.getByRole('button', { name: '隐藏' }).click();
		}
		await expect(page.getByText('隐藏默认页？')).toBeVisible({ timeout: 5000 });
	}).toPass({ timeout: 30_000 });

	await page.getByRole('button', { name: '取消' }).click();
	await expect(page.getByText('隐藏默认页？')).toBeHidden();
	await expect(rowAbout.getByText('可见')).toBeVisible();
});

test('the editor saves localized titles and carries the slug rules', async ({ page }) => {
	await page.goto(`/admin/pages/edit?id=${idA}`);
	await expect(page.getByText('额外页')).toBeVisible();
	await expect(page.getByText('md 页面')).toBeVisible();
	await expect(page.locator('input[name="slug"]')).toHaveValue(SLUG_A);

	// Reserved slug is refused by the server-side whitelist.
	await page.locator('input[name="slug"]').fill('admin');
	await expect(async () => {
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page.getByRole('alert')).toContainText('保留词', { timeout: 5000 });
	}).toPass({ timeout: 30_000 });
	expect(psql(`select slug from pages where id = '${idA}'`)).toBe(SLUG_A);

	// Fix the zh-cn title and move the slug; both persist.
	await page.locator('input[name="title_zh-cn"]').fill('E2E 管理页甲改');
	await page.locator('input[name="slug"]').fill(`${SLUG_A}2`);
	await expect(async () => {
		await page.getByRole('button', { name: '保存' }).click();
		await expect(page.getByRole('status')).toContainText('已保存', { timeout: 5000 });
	}).toPass({ timeout: 30_000 });

	expect(psql(`select title->>'zh-cn' from pages where id = '${idA}'`)).toBe('E2E 管理页甲改');
	expect(psql(`select slug from pages where id = '${idA}'`)).toBe(`${SLUG_A}2`);

	// The renamed slug serves; the old one is gone (no 301 by decision).
	const old = await page.goto(`/zh-cn/${SLUG_A}`);
	expect(old?.status()).toBe(404);
	const fresh = await page.goto(`/zh-cn/${SLUG_A}2`);
	expect(fresh?.status()).toBe(200);
	await expect(page.getByRole('heading', { name: 'E2E 管理页甲改' }).first()).toBeVisible();
});

test('the default row keeps a read-only slug in the editor', async ({ page }) => {
	const aboutId = psql(`select id from pages where slug = 'about'`);
	await page.goto(`/admin/pages/edit?id=${aboutId}`);
	await expect(page.locator('input[name="slug"]')).toHaveAttribute('readonly', '');
	await expect(page.getByText(/默认页 Slug 不可修改/)).toBeVisible();
});

test('deleting a fixture row works through the confirmation', async ({ page }) => {
	await page.goto('/admin/pages');
	const rowB = row(page, TITLE_B);
	await expect(rowB).toBeVisible();

	await expect(async () => {
		if ((await page.getByText('删除页面？').count()) === 0) {
			await rowB.getByRole('button', { name: '删除' }).click();
		}
		await expect(page.getByText('删除页面？')).toBeVisible({ timeout: 5000 });
	}).toPass({ timeout: 30_000 });

	await page.locator('form[action="?/delete"] button[type="submit"]').click();

	await expect(page.getByRole('row').filter({ hasText: TITLE_B })).toHaveCount(0, {
		timeout: 15_000
	});
	expect(psql(`select count(*) from pages where slug = '${SLUG_B}'`)).toBe('0');
	expect(idB).not.toBe('');
});

test('a malformed id answers 404 instead of crashing', async ({ page }) => {
	const response = await page.goto('/admin/pages/edit?id=not-a-uuid');
	expect(response?.status()).toBe(404);
	await expect(page.getByText('页面不存在')).toBeVisible();
});
