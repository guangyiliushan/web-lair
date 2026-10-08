import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';
import { psql } from './support';

/**
 * Projects A acceptance (plan §7 T11-T13): the real admin surface against
 * the real database - create, the four-value state machine through the bulk
 * bar, transactional reorder with the public grid staying in order, delete
 * (single + bulk), the sync enqueue (flash + queued row + dedup), the
 * recent-run card, sync-target persistence and the import error paths.
 * Fixtures share the `e2e-adminproj-` marker (deliberately outside the
 * public spec's `e2e-p%` cleanup net) and are removed around the run.
 */

const FIX = 'e2e-adminproj-';
const ROW_A = `${FIX}alpha`;
const ROW_B = `${FIX}beta`;
const ROW_C = `${FIX}gamma`;

function cleanup(): void {
	psql(`delete from projects where name like '${FIX}%'`);
	psql(`delete from job_runs where job = 'projects.sync' and status = 'queued'`);
	psql(`delete from options where name = 'projects.sync_targets'`);
}

function statusOf(name: string): string {
	return psql(`select status from projects where name = '${name}'`);
}

function rowByName(page: import('@playwright/test').Page, name: string) {
	return page.locator('li', { hasText: name });
}

async function toggleRow(page: import('@playwright/test').Page, name: string) {
	await page.getByRole('checkbox', { name: `${name} 选择` }).check();
}

test.describe.configure({ mode: 'serial', timeout: 240_000 });
test.use(zhCnLocale);

test.beforeAll(() => {
	cleanup();
});

test.afterAll(() => {
	cleanup();
});

test.describe('projects admin', () => {
	test('creates a row through the dialog and deletes it through the confirm', async ({ page }) => {
		await page.goto('/admin/projects');
		await expect(page.getByRole('heading', { name: '项目' })).toBeVisible({ timeout: 20_000 });

		await expect(async () => {
			await page.getByRole('button', { name: '新建项目' }).click({ timeout: 5000 });
			await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 20_000 });
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('名称').fill(ROW_C);
		await dialog.getByLabel('主链接').fill('https://gamma.example/');
		await dialog.getByRole('button', { name: '创建' }).click({ timeout: 5000 });
		await expect(dialog).toBeHidden({ timeout: 20_000 });
		await expect(page.getByText('项目已创建。')).toBeVisible({ timeout: 20_000 });
		expect(statusOf(ROW_C)).toBe('published');

		// Single delete through the row trash + confirm dialog.
		const row = rowByName(page, ROW_C);
		await expect(row).toBeVisible({ timeout: 20_000 });
		await row.getByRole('button', { name: '删除', exact: true }).click({ timeout: 5000 });
		const confirm = page.getByRole('alertdialog');
		await expect(confirm).toBeVisible({ timeout: 5000 });
		await confirm.getByRole('button', { name: '删除' }).click({ timeout: 5000 });
		await expect(confirm).toBeHidden({ timeout: 20_000 });
		await expect(rowByName(page, ROW_C)).toHaveCount(0, { timeout: 20_000 });
		expect(psql(`select count(*) from projects where name = '${ROW_C}'`)).toBe('0');
	});

	test('walks the state machine through the bulk bar', async ({ page }) => {
		psql(
			`insert into projects (name, provider, project_url, status, sort_order) values ('${ROW_A}', 'other', 'https://alpha.example/', 'pending', 1)`
		);
		await page.goto('/admin/projects?status=pending');
		const row = rowByName(page, ROW_A);
		await expect(row).toBeVisible({ timeout: 20_000 });

		// pending -> published (T11: visible on the public grid).
		await toggleRow(page, ROW_A);
		await page.getByRole('button', { name: '通过' }).click({ timeout: 5000 });
		await expect(page.getByText('已更新 1 项，跳过 0 项。')).toBeVisible({ timeout: 20_000 });
		expect(statusOf(ROW_A)).toBe('published');
		await page.goto('/zh-cn/projects');
		await expect(page.getByText(ROW_A)).toBeVisible({ timeout: 20_000 });

		// published -> hidden -> published.
		await page.goto('/admin/projects?status=published');
		await expect(rowByName(page, ROW_A)).toBeVisible({ timeout: 20_000 });
		await toggleRow(page, ROW_A);
		await page.getByRole('button', { name: '下架' }).click({ timeout: 5000 });
		await expect(page.getByText('已更新 1 项，跳过 0 项。')).toBeVisible({ timeout: 20_000 });
		expect(statusOf(ROW_A)).toBe('hidden');
		await page.goto('/admin/projects?status=hidden');
		await expect(rowByName(page, ROW_A)).toBeVisible({ timeout: 20_000 });
		await toggleRow(page, ROW_A);
		await page.getByRole('button', { name: '通过' }).click({ timeout: 5000 });
		await expect(page.getByText('已更新 1 项，跳过 0 项。')).toBeVisible({ timeout: 20_000 });
		expect(statusOf(ROW_A)).toBe('published');

		// published -> rejected (permanent memory) -> restored to pending.
		await page.goto('/admin/projects?status=published');
		await expect(rowByName(page, ROW_A)).toBeVisible({ timeout: 20_000 });
		await toggleRow(page, ROW_A);
		await page.getByRole('button', { name: '拒绝' }).click({ timeout: 5000 });
		await expect(page.getByText('已更新 1 项，跳过 0 项。')).toBeVisible({ timeout: 20_000 });
		expect(statusOf(ROW_A)).toBe('rejected');
		await page.goto('/admin/projects?status=rejected');
		await expect(rowByName(page, ROW_A)).toBeVisible({ timeout: 20_000 });
		await toggleRow(page, ROW_A);
		await page.getByRole('button', { name: '恢复为待复核' }).click({ timeout: 5000 });
		await expect(page.getByText('已更新 1 项，跳过 0 项。')).toBeVisible({ timeout: 20_000 });
		expect(statusOf(ROW_A)).toBe('pending');
	});

	test('reorders transactionally and the public grid follows', async ({ page }) => {
		psql(`update projects set status = 'published', sort_order = 1 where name = '${ROW_A}'`);
		psql(
			`insert into projects (name, provider, project_url, status, sort_order) values ('${ROW_B}', 'other', 'https://beta.example/', 'published', 2)`
		);
		await page.goto('/admin/projects?status=published');
		await expect(rowByName(page, ROW_A)).toBeVisible({ timeout: 20_000 });

		// Pin beta to the top; the full list renumbers 1..N.
		await rowByName(page, ROW_B).getByRole('button', { name: '置顶' }).click({ timeout: 5000 });
		await expect(async () => {
			const order = psql(
				`select string_agg(name, ',' order by sort_order) from projects where name like '${FIX}%'`
			);
			expect(order).toBe(`${ROW_B},${ROW_A}`);
		}).toPass({ timeout: 20_000 });
		expect(psql(`select sort_order from projects where name = '${ROW_A}'`)).toBe('2');

		// Public grid shows beta before alpha (T12).
		await page.goto('/zh-cn/projects');
		const order = await page
			.locator('[role="listitem"]')
			.evaluateAll(
				(elements, [a, b]) =>
					[
						elements.findIndex((el) => el.textContent?.includes(a as string)),
						elements.findIndex((el) => el.textContent?.includes(b as string))
					] as [number, number],
				[ROW_B, ROW_A]
			);
		expect(order[0]).toBeGreaterThanOrEqual(0);
		expect(order[1]).toBeGreaterThan(order[0]);
	});

	test('enqueues the sync, dedups a second click and shows the run card', async ({ page }) => {
		await page.goto('/admin/projects');
		await expect(async () => {
			await page.getByRole('button', { name: '同步', exact: true }).click({ timeout: 5000 });
			await expect(page.getByText('同步已入队——drain 将执行本次运行。')).toBeVisible({
				timeout: 5000
			});
		}).toPass({ timeout: 20_000 });
		expect(
			psql(`select count(*) from job_runs where job = 'projects.sync' and status = 'queued'`)
		).toBe('1');
		await expect(page.getByText('排队中')).toBeVisible({ timeout: 20_000 });

		await expect(async () => {
			await page.getByRole('button', { name: '同步', exact: true }).click({ timeout: 5000 });
			await expect(page.getByText('已有一次同步在队列中。')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 20_000 });
		expect(
			psql(`select count(*) from job_runs where job = 'projects.sync' and status = 'queued'`)
		).toBe('1');
	});

	test('persists sync targets and restores the removal semantics copy', async ({ page }) => {
		await page.goto('/admin/projects');
		await expect(async () => {
			await page.getByRole('button', { name: '同步目标' }).click({ timeout: 5000 });
			await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 20_000 });
		const dialog = page.getByRole('dialog');
		await dialog.getByRole('button', { name: '添加账号' }).click({ timeout: 5000 });
		await dialog.getByLabel('账号').fill('e2e-account');
		await dialog.getByRole('button', { name: '保存' }).click({ timeout: 5000 });
		await expect(dialog).toBeHidden({ timeout: 20_000 });
		await expect(page.getByText('同步目标已保存。')).toBeVisible({ timeout: 20_000 });
		expect(
			psql(
				`select value from options where name = 'projects.sync_targets' and value::text like '%e2e-account%'`
			)
		).toContain('e2e-account');

		// Duplicate (provider, account) pairs are refused by the registry.
		await expect(async () => {
			await page.getByRole('button', { name: '同步目标' }).click({ timeout: 5000 });
			await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 20_000 });
		await dialog.getByRole('button', { name: '添加账号' }).click({ timeout: 5000 });
		await dialog.getByLabel('账号').nth(1).fill('e2e-account');
		await dialog.getByRole('button', { name: '保存' }).click({ timeout: 5000 });
		await expect(
			dialog.getByText('同步目标校验失败：账号不能为空，同一平台账号不可重复')
		).toBeVisible({ timeout: 20_000 });
		await page.keyboard.press('Escape');
	});

	test('import dialog surfaces error paths without leaving the page', async ({ page }) => {
		await page.goto('/admin/projects');
		await expect(async () => {
			await page.getByRole('button', { name: '从链接导入' }).click({ timeout: 5000 });
			await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
		}).toPass({ timeout: 20_000 });
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('链接').fill('not-a-url');
		await dialog.getByRole('button', { name: '获取元数据' }).click({ timeout: 5000 });
		await expect(dialog.getByText('链接无效（需要 https 地址）')).toBeVisible({
			timeout: 20_000
		});
		await dialog.getByLabel('链接').fill('https://nx.invalid/page');
		await dialog.getByRole('button', { name: '获取元数据' }).click({ timeout: 5000 });
		await expect(dialog.getByText('网络错误，请稍后再试')).toBeVisible({ timeout: 30_000 });
	});

	test('bulk delete removes the selected rows', async ({ page }) => {
		psql(`update projects set status = 'published' where name like '${FIX}%'`);
		await page.goto('/admin/projects?status=published');
		await expect(rowByName(page, ROW_A)).toBeVisible({ timeout: 20_000 });
		await toggleRow(page, ROW_A);
		await toggleRow(page, ROW_B);
		await page.getByRole('button', { name: '删除', exact: true }).first().click({
			timeout: 5000
		});
		const confirm = page.getByRole('alertdialog');
		await expect(confirm).toBeVisible({ timeout: 5000 });
		await confirm.getByRole('button', { name: '删除' }).click({ timeout: 5000 });
		await expect(page.getByText('项目已删除。')).toBeVisible({ timeout: 20_000 });
		expect(psql(`select count(*) from projects where name like '${FIX}%'`)).toBe('0');
	});
});
