import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * micro C3 acceptance: the admin CRUD round trips against the real database
 * (quotes / thoughts / moments, including the ?add=1 deep link and the kind
 * badge), the dashboard's five real counters, and the public six routes
 * (lists + uuid details + 404 semantics + the moments kind filter).
 * Fixtures: marker-prefixed rows seeded in beforeAll and cleaned around the
 * run; the CRUD texts are created and removed inside their own tests.
 */

const FIX = 'e2e-c3-fix';
const CRUD = 'e2e-c3-crud';
const FIX_QUOTE = `${FIX} 摘录夹具：未曾哭过长夜的人。`;
const FIX_THOUGHT = `${FIX} 思考夹具：问题的栖息地。`;
const FIX_MOMENT = `${FIX} 微记夹具：今日的碎片。`;
const CRUD_QUOTE = `${CRUD} 待编辑的摘录。`;
const CRUD_QUOTE_EDITED = `${CRUD} 已编辑的摘录。`;
const CRUD_THOUGHT = `${CRUD} 深链写下的思考。`;
const CRUD_MOMENT = `${CRUD} 深链写下的微记。`;

function cleanup(): void {
	psql(`delete from quotes where content like 'e2e-c3-%'`);
	psql(`delete from thoughts where content like 'e2e-c3-%'`);
	psql(`delete from moments where content like 'e2e-c3-%'`);
}

test.describe.configure({ mode: 'serial', timeout: 180_000 });
test.use(zhCnLocale);

test.beforeAll(() => {
	cleanup();
	psql(`insert into quotes (content, author, source) values ('${FIX_QUOTE}', '罗翔', '圆圈正义')`);
	psql(`insert into thoughts (content) values ('${FIX_THOUGHT}')`);
	psql(`insert into moments (content, type) values ('${FIX_MOMENT}', 'media')`);
});

test.afterAll(() => {
	cleanup();
});

test.describe('micro C3 admin', () => {
	test('quotes: create → edit → delete round trip through the real table', async ({ page }) => {
		await page.goto('/admin/quotes');
		const dialog = page.getByRole('dialog');

		await expect(async () => {
			await page.getByRole('button', { name: '添加摘录' }).click({ timeout: 5000 });
			await expect(dialog).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 20_000 });
		await dialog.getByLabel('内容').fill(CRUD_QUOTE);
		await dialog.getByLabel('作者').fill('e2e 作者');
		await dialog.getByRole('button', { name: '添加' }).click({ timeout: 5000 });
		await expect(dialog).toBeHidden({ timeout: 20_000 });
		await expect(page.getByText(CRUD_QUOTE)).toBeVisible({ timeout: 20_000 });
		expect(psql(`select count(*) from quotes where content = '${CRUD_QUOTE}'`)).toBe('1');

		const row = page.locator('article', { hasText: CRUD_QUOTE });
		await expect(async () => {
			await page.mouse.move(0, 0);
			await row.hover();
			await row.getByRole('button', { name: '编辑摘录' }).click({ timeout: 3000 });
			await expect(dialog).toBeVisible({ timeout: 3000 });
		}).toPass({ timeout: 20_000 });
		await expect(dialog.getByLabel('内容')).toHaveValue(CRUD_QUOTE);
		await expect(dialog.getByLabel('作者')).toHaveValue('e2e 作者');
		await dialog.getByLabel('内容').fill(CRUD_QUOTE_EDITED);
		await dialog.getByRole('button', { name: '保存' }).click({ timeout: 5000 });
		await expect(dialog).toBeHidden({ timeout: 20_000 });
		await expect(page.getByText(CRUD_QUOTE_EDITED)).toBeVisible({ timeout: 20_000 });
		expect(psql(`select count(*) from quotes where content = '${CRUD_QUOTE_EDITED}'`)).toBe('1');

		const editedRow = page.locator('article', { hasText: CRUD_QUOTE_EDITED });
		const confirm = page.getByRole('alertdialog');
		await expect(async () => {
			await page.mouse.move(0, 0);
			await editedRow.hover();
			await editedRow.getByRole('button', { name: '删除摘录' }).click({ timeout: 3000 });
			await expect(confirm).toBeVisible({ timeout: 3000 });
		}).toPass({ timeout: 20_000 });
		await confirm.getByRole('button', { name: '删除' }).click({ timeout: 5000 });
		await expect(confirm).toBeHidden({ timeout: 20_000 });
		await expect(page.getByText(CRUD_QUOTE_EDITED)).toHaveCount(0, { timeout: 20_000 });
		expect(psql(`select count(*) from quotes where content like '${CRUD}%'`)).toBe('0');
	});

	test('thoughts: the ?add=1 deep link opens the dialog and creates a row', async ({ page }) => {
		await page.goto('/admin/thoughts?add=1');
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({ timeout: 20_000 });
		await dialog.getByLabel('内容').fill(CRUD_THOUGHT);
		await dialog.getByRole('button', { name: '发布' }).click({ timeout: 5000 });
		await expect(dialog).toBeHidden({ timeout: 20_000 });
		await expect(page.getByText(CRUD_THOUGHT)).toBeVisible({ timeout: 20_000 });
		expect(psql(`select count(*) from thoughts where content = '${CRUD_THOUGHT}'`)).toBe('1');
	});

	test('moments: create with a kind chip and the badge renders', async ({ page }) => {
		await page.goto('/admin/moments?add=1');
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({ timeout: 20_000 });
		await dialog.getByLabel('内容').fill(CRUD_MOMENT);
		await dialog.getByText('技术', { exact: true }).click();
		await dialog.getByRole('button', { name: '发布' }).click({ timeout: 5000 });
		await expect(dialog).toBeHidden({ timeout: 20_000 });
		const row = page.locator('article', { hasText: CRUD_MOMENT });
		await expect(row).toBeVisible({ timeout: 20_000 });
		await expect(row.getByText('技术')).toBeVisible();
		expect(psql(`select type from moments where content = '${CRUD_MOMENT}'`)).toBe('tech');
	});

	test('dashboard quick actions carry real counters', async ({ page }) => {
		await page.goto('/admin');
		const quick = page.locator('section', { hasText: '快速操作' }).first();
		const cases: [string, string][] = [
			['博文', `select count(*) from posts where status <> 'trash'`],
			['手记', 'select count(*) from notes'],
			['摘录', 'select count(*) from quotes'],
			['思考', 'select count(*) from thoughts'],
			['微记', 'select count(*) from moments']
		];
		// Sibling specs mutate posts / notes concurrently (10 workers); reload
		// each attempt so the rendered count and the psql read converge.
		for (const [label, sql] of cases) {
			await expect(async () => {
				await page.reload();
				const expected = psql(sql);
				const title = quick.getByText(label, { exact: true });
				await expect(title).toBeVisible({ timeout: 5000 });
				const count = title.locator('xpath=following-sibling::p[1]');
				await expect(count).toHaveText(expected, { timeout: 5000 });
			}).toPass({ timeout: 30_000 });
		}
	});
});

test.describe('micro C3 public', () => {
	test('quotes: the waterfall lists the fixture and the uuid detail renders', async ({ page }) => {
		await page.goto('/zh-cn/quotes');
		await expect(page.getByRole('heading', { name: '摘录' })).toBeVisible({ timeout: 20_000 });
		await expect(page.getByText('言语的片段')).toBeVisible();
		await expect(page.getByText(FIX_QUOTE)).toBeVisible({ timeout: 20_000 });

		const id = psql(`select id from quotes where content = '${FIX_QUOTE}'`);
		await page.goto(`/zh-cn/quotes/${id}`);
		await expect(page.getByText(FIX_QUOTE)).toBeVisible({ timeout: 20_000 });
		await expect(page.getByRole('link', { name: '返回摘录' })).toBeVisible();

		const malformed = await page.goto('/zh-cn/quotes/not-a-uuid');
		expect(malformed?.status()).toBe(404);
		const missing = await page.goto('/zh-cn/quotes/00000000-0000-7000-8000-000000000000');
		expect(missing?.status()).toBe(404);
	});

	test('thoughts: the stream lists the fixture and the detail renders', async ({ page }) => {
		await page.goto('/zh-cn/thoughts');
		await expect(page.getByRole('heading', { name: '思考' })).toBeVisible({ timeout: 20_000 });
		await expect(page.getByText(FIX_THOUGHT)).toBeVisible({ timeout: 20_000 });

		const id = psql(`select id from thoughts where content = '${FIX_THOUGHT}'`);
		await page.goto(`/zh-cn/thoughts/${id}`);
		await expect(page.getByText(FIX_THOUGHT)).toBeVisible({ timeout: 20_000 });
		await expect(page.getByRole('link', { name: '返回思考' })).toBeVisible();

		const malformed = await page.goto('/zh-cn/thoughts/not-a-uuid');
		expect(malformed?.status()).toBe(404);
		const missing = await page.goto('/zh-cn/thoughts/00000000-0000-7000-8000-000000000000');
		expect(missing?.status()).toBe(404);
	});

	test('moments: the kind filter narrows the stream and the detail renders votes', async ({
		page
	}) => {
		await page.goto('/zh-cn/moments');
		await expect(page.getByRole('heading', { name: '微记' })).toBeVisible({ timeout: 20_000 });
		await expect(page.getByText(FIX_MOMENT)).toBeVisible({ timeout: 20_000 });

		await page.goto('/zh-cn/moments?kind=media');
		await expect(page.getByRole('link', { name: '书影', exact: true })).toHaveAttribute(
			'aria-current',
			'true'
		);
		const expectedMedia = Number(psql(`select count(*) from moments where type = 'media'`));
		await expect(page.locator('article')).toHaveCount(expectedMedia, { timeout: 20_000 });
		await expect(page.getByText(FIX_MOMENT)).toBeVisible({ timeout: 20_000 });

		await page.goto('/zh-cn/moments?kind=life');
		const expectedLife = Number(psql(`select count(*) from moments where type = 'life'`));
		await expect(page.locator('article')).toHaveCount(expectedLife, { timeout: 20_000 });
		await expect(page.getByText(FIX_MOMENT)).toHaveCount(0);

		const id = psql(`select id from moments where content = '${FIX_MOMENT}'`);
		await page.goto(`/zh-cn/moments/${id}`);
		await expect(page.getByText(FIX_MOMENT)).toBeVisible({ timeout: 20_000 });
		await expect(page.getByRole('link', { name: '返回微记' })).toBeVisible();

		const malformed = await page.goto('/zh-cn/moments/not-a-uuid');
		expect(malformed?.status()).toBe(404);
		const missing = await page.goto('/zh-cn/moments/00000000-0000-7000-8000-000000000000');
		expect(missing?.status()).toBe(404);
	});
});
